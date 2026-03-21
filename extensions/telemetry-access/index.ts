/**
 * Telemetry Access Extension
 *
 * Gives the agent typed, structured tools to query production telemetry —
 * logs, errors, metrics, and product analytics — without needing to know
 * the syntax of each provider's CLI or API.
 *
 * The agent uses these tools to:
 *   - Diagnose production issues (logs, errors)
 *   - Verify product success conditions from PRODUCT.md (analytics)
 *   - Run signal reviews — technical health + product signals (the closed loop)
 *   - Verify Gate 5 (measurement readiness) after deployment
 *
 * Config: .pi/telemetry.config.json (or project root telemetry.config.json)
 * See templates/telemetry.config.json for the format.
 *
 * Supported providers:
 *   Logs:      cloudwatch | kubectl | heroku | file | custom
 *   Errors:    sentry | file | custom
 *   Metrics:   cloudwatch | datadog | prometheus | custom
 *   Analytics: posthog | custom
 *
 * PostHog is the recommended analytics provider. It is:
 *   - Free at scale (self-hosted)
 *   - Queryable by the agent via HogQL (SQL over events)
 *   - Navigable by human operators via the PostHog UI
 *   - The same data, accessible at multiple levels of abstraction
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseProductMdQueries, hasSuccessConditions, hasHogQLQueries } from "../../lib/product-md";

// ─── Types ────────────────────────────────────────────────────────────────────

interface LogsConfig {
  provider: "cloudwatch" | "kubectl" | "heroku" | "file" | "custom";
  // cloudwatch
  logGroup?: string;
  region?: string;
  // kubectl
  deployment?: string;
  namespace?: string;
  // heroku
  app?: string;
  // file
  filePath?: string;
  // custom — full command template; use {pattern}, {lines}, {since} as placeholders
  command?: string;
}

interface ErrorsConfig {
  provider: "sentry" | "file" | "custom";
  // sentry
  orgSlug?: string;
  projectSlug?: string;
  tokenEnvVar?: string; // env var holding the Sentry auth token; default SENTRY_AUTH_TOKEN
  // file — same as logs.filePath but filtered for errors
  filePath?: string;
  // custom
  command?: string;
}

interface MetricsConfig {
  provider: "cloudwatch" | "datadog" | "prometheus" | "custom";
  // cloudwatch
  namespace?: string;
  region?: string;
  // datadog
  apiKeyEnvVar?: string;  // default DD_API_KEY
  appKeyEnvVar?: string;  // default DD_APP_KEY
  site?: string;          // default datadoghq.com
  // prometheus
  url?: string;           // e.g. http://prometheus:9090
  // custom
  command?: string;
}

interface AnalyticsConfig {
  provider: "posthog" | "custom";
  // PostHog — the recommended provider.
  // Queryable by the agent via HogQL; navigable by humans via the PostHog UI.
  // Self-host at any scale: https://posthog.com/docs/self-host
  host?: string;        // PostHog instance URL; default https://app.posthog.com
  projectId?: string;   // Project ID from PostHog project settings
  apiKeyEnvVar?: string; // Env var holding a personal API key; default POSTHOG_API_KEY
  // custom — any endpoint that accepts { query: string } and returns { results, columns }
  queryEndpoint?: string;
  authHeaderEnvVar?: string; // Env var for the Authorization header value
}

interface TelemetryConfig {
  logs?: LogsConfig;
  errors?: ErrorsConfig;
  metrics?: MetricsConfig;
  analytics?: AnalyticsConfig;
}

interface LogLine {
  timestamp: string;
  level?: string;
  message: string;
  raw: string;
}

interface ErrorGroup {
  type: string;
  message: string;
  count: number;
  firstSeen?: string;
  lastSeen?: string;
  example?: string;
}

interface MetricPoint {
  timestamp: string;
  value: number;
}

interface Signal {
  source: "logs" | "errors" | "metrics";
  severity: "high" | "medium" | "low";
  title: string;
  description: string;
  suggestedAction: string;
  rawData?: string;
}

// ─── Config loading ───────────────────────────────────────────────────────────

function loadConfig(cwd: string): TelemetryConfig {
  const candidates = [
    path.join(cwd, ".pi", "telemetry.config.json"),
    path.join(cwd, "telemetry.config.json"),
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(fs.readFileSync(candidate, "utf8")) as TelemetryConfig;
    } catch { /* try next */ }
  }
  return {};
}

// ─── Command builders ─────────────────────────────────────────────────────────

function buildLogsCommand(
  cfg: LogsConfig,
  pattern: string,
  lines: number,
  sinceMinutes: number,
): string {
  const since = new Date(Date.now() - sinceMinutes * 60_000).toISOString();

  switch (cfg.provider) {
    case "cloudwatch": {
      const group = cfg.logGroup ?? "/app/production";
      const region = cfg.region ? `--region ${cfg.region}` : "";
      const startTime = Date.now() - sinceMinutes * 60_000;
      const filter = pattern ? `--filter-pattern "${pattern.replace(/"/g, '\\"')}"` : "";
      return `aws logs filter-log-events ${region} --log-group-name "${group}" --start-time ${startTime} ${filter} --limit ${lines} --query 'events[*].{timestamp:timestamp,message:message}' --output json 2>&1`;
    }

    case "kubectl": {
      const deployment = cfg.deployment ?? "deployment/app";
      const ns = cfg.namespace ? `-n ${cfg.namespace}` : "";
      const grep = pattern ? `| grep -i "${pattern.replace(/"/g, '\\"')}"` : "";
      return `kubectl logs ${ns} ${deployment} --since=${sinceMinutes}m --tail=${lines} 2>&1 ${grep}`;
    }

    case "heroku": {
      const app = cfg.app ? `--app ${cfg.app}` : "";
      const grep = pattern ? `| grep -i "${pattern.replace(/"/g, '\\"')}"` : "";
      return `heroku logs ${app} --num ${lines} 2>&1 ${grep}`;
    }

    case "file": {
      const file = cfg.filePath ?? "/var/log/app.log";
      const grep = pattern ? `grep -i "${pattern.replace(/"/g, '\\"')}" "${file}"` : `cat "${file}"`;
      return `${grep} | tail -n ${lines}`;
    }

    case "custom":
      return (cfg.command ?? "echo 'No custom log command configured'")
        .replace("{pattern}", pattern)
        .replace("{lines}", String(lines))
        .replace("{since}", since);

    default:
      return `echo 'Unsupported log provider: ${cfg.provider}'`;
  }
}

function buildErrorsCommand(
  cfg: ErrorsConfig,
  sinceMinutes: number,
): string {
  switch (cfg.provider) {
    case "sentry": {
      const org = cfg.orgSlug ?? "YOUR_ORG";
      const project = cfg.projectSlug ?? "YOUR_PROJECT";
      const tokenVar = cfg.tokenEnvVar ?? "SENTRY_AUTH_TOKEN";
      return (
        `curl -sf -H "Authorization: Bearer $${tokenVar}" ` +
        `"https://sentry.io/api/0/projects/${org}/${project}/issues/?limit=25&query=is:unresolved&sort=freq" ` +
        `2>&1 | python3 -c "` +
        `import json,sys; issues=json.load(sys.stdin); ` +
        `[print(f\\"{i['count']:>6}x  {i['title']}  (last: {i['lastSeen'][:10]})\\")" +
        " for i in issues[:15]]" 2>&1`
      );
    }

    case "file": {
      const file = cfg.filePath ?? "/var/log/app.log";
      return (
        `grep -i "error\\|exception\\|fatal" "${file}" | ` +
        `awk '{for(i=1;i<=NF;i++) if($i~/[Ee]rror|[Ee]xception/) print $i}' | ` +
        `sort | uniq -c | sort -rn | head -20`
      );
    }

    case "custom":
      return cfg.command ?? "echo 'No custom errors command configured'";

    default:
      return `echo 'Unsupported errors provider: ${cfg.provider}'`;
  }
}

function buildMetricsCommand(
  cfg: MetricsConfig,
  query: string,
  sinceMinutes: number,
): string {
  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - sinceMinutes * 60;

  switch (cfg.provider) {
    case "cloudwatch": {
      const ns = cfg.namespace ?? "AWS/ApplicationELB";
      const region = cfg.region ? `--region ${cfg.region}` : "";
      return (
        `aws cloudwatch get-metric-statistics ${region} ` +
        `--namespace "${ns}" --metric-name "${query}" ` +
        `--start-time ${new Date(startTime * 1000).toISOString()} ` +
        `--end-time ${new Date(endTime * 1000).toISOString()} ` +
        `--period 300 --statistics Average Maximum ` +
        `--query 'Datapoints[*].{time:Timestamp,avg:Average,max:Maximum}' ` +
        `--output table 2>&1`
      );
    }

    case "datadog": {
      const apiKey = cfg.apiKeyEnvVar ?? "DD_API_KEY";
      const appKey = cfg.appKeyEnvVar ?? "DD_APP_KEY";
      const site = cfg.site ?? "datadoghq.com";
      return (
        `curl -sf -G "https://api.${site}/api/v1/query" ` +
        `-H "DD-API-KEY: $${apiKey}" -H "DD-APPLICATION-KEY: $${appKey}" ` +
        `--data-urlencode "from=${startTime}" ` +
        `--data-urlencode "to=${endTime}" ` +
        `--data-urlencode "query=${query}" ` +
        `2>&1 | python3 -c "import json,sys; d=json.load(sys.stdin); ` +
        `s=d.get('series',[{}])[0]; pts=s.get('pointlist',[]); ` +
        `[print(f'{int(p[0]/1000)}  {p[1]:.2f}') for p in pts[-10:]]" 2>&1`
      );
    }

    case "prometheus": {
      const url = cfg.url ?? "http://localhost:9090";
      return (
        `curl -sf "${url}/api/v1/query_range" ` +
        `--data-urlencode "query=${query}" ` +
        `--data-urlencode "start=${startTime}" ` +
        `--data-urlencode "end=${endTime}" ` +
        `--data-urlencode "step=60" ` +
        `2>&1 | python3 -c "import json,sys; r=json.load(sys.stdin); ` +
        `rs=r.get('data',{}).get('result',[]); ` +
        `[print(f'{v[0]}  {float(v[1]):.4f}') for rs_i in rs[:1] for v in rs_i.get('values',[])[-10:]]" 2>&1`
      );
    }

    case "custom":
      return (cfg.command ?? "echo 'No custom metrics command configured'")
        .replace("{query}", query)
        .replace("{start}", String(startTime))
        .replace("{end}", String(endTime));

    default:
      return `echo 'Unsupported metrics provider: ${cfg.provider}'`;
  }
}

// ─── Output parsing ───────────────────────────────────────────────────────────

function parseLogOutput(stdout: string, limit: number): LogLine[] {
  const lines = stdout.trim().split("\n").filter(Boolean).slice(-limit);

  // Try JSON first (CloudWatch returns JSON)
  try {
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) {
      return parsed.map((e: { timestamp?: number; message?: string }) => ({
        timestamp: e.timestamp ? new Date(e.timestamp).toISOString() : "",
        message: (e.message ?? "").trim(),
        raw: JSON.stringify(e),
      }));
    }
  } catch { /* not JSON — fall through to line-by-line */ }

  // Detect level from common log formats
  const levelPattern = /\b(DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL)\b/i;
  const tsPattern = /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})/;

  return lines.map((line) => {
    const level = levelPattern.exec(line)?.[1]?.toUpperCase();
    const timestamp = tsPattern.exec(line)?.[1] ?? "";
    return { timestamp, level, message: line.slice(0, 200), raw: line };
  });
}

function detectSignals(
  logs: LogLine[],
  errorOutput: string,
  metricsOutput: string,
): Signal[] {
  const signals: Signal[] = [];

  // Error rate from logs
  const errorLines = logs.filter((l) => l.level === "ERROR" || l.level === "FATAL");
  const errorRate = errorLines.length / Math.max(logs.length, 1);
  if (errorRate > 0.1) {
    const topError = errorLines[0]?.message ?? "Unknown error";
    signals.push({
      source: "logs",
      severity: errorRate > 0.3 ? "high" : "medium",
      title: `High error rate: ${(errorRate * 100).toFixed(0)}% of log lines are errors`,
      description: `Most recent: ${topError.slice(0, 120)}`,
      suggestedAction: "Investigate with query_errors for grouping. Likely a gap bug — check if a regression spec covers this case.",
    });
  }

  // Error tracking signals
  if (errorOutput && !errorOutput.includes("No custom") && errorOutput.trim()) {
    const lines = errorOutput.trim().split("\n").filter(Boolean);
    const highFreq = lines.filter((l) => {
      const count = parseInt(l.trim().split(/\s+/)[0] ?? "0", 10);
      return count > 50;
    });
    if (highFreq.length > 0) {
      signals.push({
        source: "errors",
        severity: "high",
        title: `${highFreq.length} high-frequency error type(s) in error tracker`,
        description: highFreq.slice(0, 3).join("\n"),
        suggestedAction: "Each high-frequency error is a gap bug. Run report_bug for the most impactful one.",
      });
    }
  }

  // Metrics signals (simple: look for "nan" or very high values)
  if (metricsOutput && metricsOutput.includes("nan")) {
    signals.push({
      source: "metrics",
      severity: "medium",
      title: "Metrics returning NaN — instrumentation gap",
      description: "One or more metrics queries returned NaN, suggesting missing or misconfigured telemetry.",
      suggestedAction: "Verify the telemetry spec in PRODUCT.md matches what the application is emitting.",
    });
  }

  return signals;
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let config: TelemetryConfig = {};

  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig(ctx.cwd);
    if (Object.keys(config).length > 0) {
      ctx.ui.notify(
        `📡 Telemetry access configured: ${Object.keys(config).join(", ")}`,
        "info",
      );
    }
  });

  // ── query_logs ───────────────────────────────────────────────────────────

  pi.registerTool({
    name: "query_logs",
    label: "Query Logs",
    description:
      "Query production logs for a pattern. Returns matching log lines with timestamps and severity. " +
      "Use to investigate errors, trace request flows, or understand user behaviour patterns. " +
      "Requires logs configuration in .pi/telemetry.config.json.",
    promptSnippet: "Search production logs for a pattern",
    promptGuidelines: [
      "Use query_logs to investigate reported errors before filing a bug report.",
      "Search for error patterns, specific user IDs, or request paths.",
      "Use the level parameter to filter to errors only when diagnosing failures.",
      "Combine with query_errors for a complete picture of production failures.",
    ],
    parameters: Type.Object({
      pattern: Type.String({
        description: "Search pattern (plain text or grep-compatible regex). E.g. 'payment failed', 'ERROR', 'user_id:123'",
      }),
      timeWindowMinutes: Type.Optional(Type.Number({
        description: "How many minutes back to search. Default: 60",
      })),
      limit: Type.Optional(Type.Number({
        description: "Maximum number of log lines to return. Default: 50",
      })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const cfg = config.logs;
      if (!cfg) {
        return {
          content: [{ type: "text", text: "No logs configuration found. Add a logs section to .pi/telemetry.config.json." }],
          details: { configured: false },
        };
      }

      const lines = params.limit ?? 50;
      const minutes = params.timeWindowMinutes ?? 60;
      const cmd = buildLogsCommand(cfg, params.pattern, lines, minutes);

      onUpdate?.({ content: [{ type: "text", text: `Querying ${cfg.provider} logs for: ${params.pattern}` }] });

      let stdout = "";
      try {
        const result = await pi.exec("bash", ["-c", cmd], { signal, timeout: 30_000 });
        stdout = `${result.stdout}\n${result.stderr}`.trim();
      } catch (err: unknown) {
        stdout = err instanceof Error ? err.message : String(err);
      }

      const parsed = parseLogOutput(stdout, lines);
      const errorCount = parsed.filter((l) => l.level === "ERROR" || l.level === "FATAL").length;

      const summary = [
        `Found ${parsed.length} log line(s) matching "${params.pattern}" in the last ${minutes} minutes.`,
        errorCount > 0 ? `⚠ ${errorCount} error/fatal lines.` : "",
        "",
        parsed.slice(0, 20).map((l) =>
          `[${l.timestamp || "?"}] ${l.level ? `[${l.level}] ` : ""}${l.message}`
        ).join("\n"),
        parsed.length > 20 ? `\n... and ${parsed.length - 20} more lines.` : "",
      ].filter(Boolean).join("\n");

      return {
        content: [{ type: "text", text: summary }],
        details: { lines: parsed, errorCount, pattern: params.pattern, provider: cfg.provider },
      };
    },
  });

  // ── query_errors ─────────────────────────────────────────────────────────

  pi.registerTool({
    name: "query_errors",
    label: "Query Errors",
    description:
      "Query the error tracking system for grouped error summaries. " +
      "Returns errors sorted by frequency — the most impactful issues first. " +
      "Use to identify which errors are worth filing as bug reports. " +
      "Requires errors configuration in .pi/telemetry.config.json.",
    promptSnippet: "Get grouped error summary from error tracker",
    promptGuidelines: [
      "Use query_errors at the start of a signal review to identify the highest-impact bugs.",
      "Each distinct error group is a candidate gap bug — check if any existing spec covers it.",
      "High-frequency errors that have no corresponding spec should be filed with report_bug.",
      "Use query_logs to get the full context for a specific error type.",
    ],
    parameters: Type.Object({
      timeWindowMinutes: Type.Optional(Type.Number({
        description: "How many minutes back to look. Default: 1440 (24 hours)",
      })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      const cfg = config.errors;
      if (!cfg) {
        return {
          content: [{ type: "text", text: "No errors configuration found. Add an errors section to .pi/telemetry.config.json." }],
          details: { configured: false },
        };
      }

      const minutes = params.timeWindowMinutes ?? 1440;
      const cmd = buildErrorsCommand(cfg, minutes);

      onUpdate?.({ content: [{ type: "text", text: `Querying ${cfg.provider} for error groups...` }] });

      let stdout = "";
      try {
        const result = await pi.exec("bash", ["-c", cmd], { signal, timeout: 30_000 });
        stdout = `${result.stdout}\n${result.stderr}`.trim();
      } catch (err: unknown) {
        stdout = err instanceof Error ? err.message : String(err);
      }

      const lines = stdout.split("\n").filter(Boolean);
      const header = `Error summary (${cfg.provider}, last ${minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`}):`;

      return {
        content: [{ type: "text", text: `${header}\n\n${stdout.slice(0, 3000)}` }],
        details: { rawOutput: stdout, provider: cfg.provider, lineCount: lines.length },
      };
    },
  });

  // ── query_metrics ─────────────────────────────────────────────────────────

  pi.registerTool({
    name: "query_metrics",
    label: "Query Metrics",
    description:
      "Query a specific metric from the metrics system. " +
      "Returns data points over the requested time window. " +
      "Use to check if success conditions defined in PRODUCT.md are being met. " +
      "Requires metrics configuration in .pi/telemetry.config.json.",
    promptSnippet: "Query a production metric (latency, error rate, etc.)",
    promptGuidelines: [
      "Use query_metrics to check whether success conditions in PRODUCT.md are being achieved.",
      "Query error rates, latency percentiles, and feature adoption metrics.",
      "If a success condition threshold is being missed, that is a non-functional bug.",
      "Use the metric query syntax appropriate for the configured provider.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "Metric query in the provider's query language. " +
          "CloudWatch: metric name (e.g. 'Latency'). " +
          "Datadog: metric query (e.g. 'avg:request.latency{service:api}'). " +
          "Prometheus: PromQL (e.g. 'rate(http_requests_total[5m])').",
      }),
      timeWindowMinutes: Type.Optional(Type.Number({
        description: "How many minutes back to query. Default: 60",
      })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      const cfg = config.metrics;
      if (!cfg) {
        return {
          content: [{ type: "text", text: "No metrics configuration found. Add a metrics section to .pi/telemetry.config.json." }],
          details: { configured: false },
        };
      }

      const minutes = params.timeWindowMinutes ?? 60;
      const cmd = buildMetricsCommand(cfg, params.query, minutes);

      onUpdate?.({ content: [{ type: "text", text: `Querying ${cfg.provider} metric: ${params.query}` }] });

      let stdout = "";
      try {
        const result = await pi.exec("bash", ["-c", cmd], { signal, timeout: 30_000 });
        stdout = `${result.stdout}\n${result.stderr}`.trim();
      } catch (err: unknown) {
        stdout = err instanceof Error ? err.message : String(err);
      }

      return {
        content: [{
          type: "text",
          text: `Metric: ${params.query} (${cfg.provider}, last ${minutes}m)\n\n${stdout.slice(0, 2000)}`,
        }],
        details: { query: params.query, rawOutput: stdout, provider: cfg.provider },
      };
    },
  });

  // ── query_signals ─────────────────────────────────────────────────────────

  pi.registerTool({
    name: "query_signals",
    label: "Query Production Signals",
    description:
      "Comprehensive production signal review. Queries all configured telemetry sources " +
      "(logs, errors, metrics) and synthesises findings into a prioritised list of signals " +
      "— each mapped to a suggested BDD cycle action (bug report, new spec, or validation check). " +
      "Use this as the entry point for a /signal-review session.",
    promptSnippet: "Run a comprehensive production signal review (closes the loop)",
    promptGuidelines: [
      "Call query_signals at the start of every /signal-review session.",
      "Each returned signal maps to a BDD action: gap bug, spec defect, new feature, or non-functional bug.",
      "Load signal-to-spec skill to determine the right BDD entry point for each signal.",
      "Present signals to the user in priority order and confirm before acting on any.",
      "Do not automatically create bug reports or specs — surface them for human approval first.",
    ],
    parameters: Type.Object({
      timeWindowMinutes: Type.Optional(Type.Number({
        description: "How many minutes back to analyse. Default: 1440 (24 hours)",
      })),
      focusPattern: Type.Optional(Type.String({
        description: "Optional: focus log search on a specific pattern or feature area.",
      })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const minutes = params.timeWindowMinutes ?? 1440;
      const pattern = params.focusPattern ?? "error|exception|failed|timeout";

      onUpdate?.({ content: [{ type: "text", text: "🔍 Starting production signal review..." }] });

      // Query all configured sources sequentially
      // (parallel sub-agent implementation is future work — see architecture notes)
      let logOutput = "";
      let errorOutput = "";
      let metricsOutput = "";
      const configured: string[] = [];

      if (config.logs) {
        configured.push("logs");
        onUpdate?.({ content: [{ type: "text", text: "  Querying logs..." }] });
        try {
          const cmd = buildLogsCommand(config.logs, pattern, 200, minutes);
          const r = await pi.exec("bash", ["-c", cmd], { signal, timeout: 30_000 });
          logOutput = `${r.stdout}\n${r.stderr}`.trim();
        } catch { /* proceed without */ }
      }

      if (config.errors) {
        configured.push("errors");
        onUpdate?.({ content: [{ type: "text", text: "  Querying error tracker..." }] });
        try {
          const cmd = buildErrorsCommand(config.errors, minutes);
          const r = await pi.exec("bash", ["-c", cmd], { signal, timeout: 30_000 });
          errorOutput = `${r.stdout}\n${r.stderr}`.trim();
        } catch { /* proceed without */ }
      }

      if (config.metrics) {
        configured.push("metrics");
        onUpdate?.({ content: [{ type: "text", text: "  Querying metrics..." }] });
        // Query a default health metric if configured
        try {
          const defaultQuery = config.metrics.provider === "prometheus"
            ? "rate(http_requests_total[5m])"
            : config.metrics.provider === "datadog"
            ? "avg:system.load.1{*}"
            : "Latency";
          const cmd = buildMetricsCommand(config.metrics, defaultQuery, 60);
          const r = await pi.exec("bash", ["-c", cmd], { signal, timeout: 30_000 });
          metricsOutput = `${r.stdout}\n${r.stderr}`.trim();
        } catch { /* proceed without */ }
      }

      // Also check product analytics success conditions
      let productSignals: Signal[] = [];
      if (config.analytics) {
        configured.push("analytics");
        onUpdate?.({ content: [{ type: "text", text: "  Checking product success conditions..." }] });
        // Listen for signals emitted by check_success_conditions
        const handler = (data: unknown) => {
          const d = data as { signals?: Signal[] };
          if (d.signals) productSignals = productSignals.concat(d.signals);
        };
        pi.events.on("telemetry:product_signals", handler);
        try {
          // Use shared parser to avoid duplicating PRODUCT.md parsing logic
          const queries = parseProductMdQueries(ctx.cwd);
          for (const pq of queries) {
            if (!pq.target) continue;
            const { results: qr } = await runHogQL(pq.query, signal);
            const current = qr[0]?.[0] != null ? parseFloat(String(qr[0][0])) : null;
            if (current != null && current < pq.target) {
              productSignals.push({
                source: "metrics",
                severity: current < pq.target * 0.7 ? "high" : "medium",
                title: `Success condition not met: ${pq.featureName}`,
                description: `Current: ${current.toFixed(3)}, target: ${pq.targetStr}`,
                suggestedAction: "Load signal-to-spec — this is a product-level signal requiring a BDD action.",
              });
            }
          }
        } catch { /* proceed without product signals */ }
        pi.events.removeListener?.("telemetry:product_signals", handler);
      }

      if (configured.length === 0) {
        return {
          content: [{
            type: "text",
            text: "No telemetry sources configured. Add logs, errors, metrics, and/or analytics to .pi/telemetry.config.json.",
          }],
          details: { signals: [], configured: [] },
        };
      }

      // Parse and detect technical signals
      const parsedLogs = logOutput ? parseLogOutput(logOutput, 200) : [];
      const technicalSignals = detectSignals(parsedLogs, errorOutput, metricsOutput);
      const signals = [...productSignals, ...technicalSignals];

      // Build the signal review report
      const lines: string[] = [
        `📡 Production Signal Review`,
        `Time window: last ${minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`}`,
        `Sources queried: ${configured.join(", ")}`,
        "",
      ];

      const productOnly = signals.filter((s) => productSignals.includes(s));
      const technicalOnly = signals.filter((s) => !productSignals.includes(s));

      if (signals.length === 0) {
        lines.push("✓ No significant signals detected.");
        lines.push("");
        if (!config.analytics) {
          lines.push("⚠ Product analytics not configured — success conditions not checked.");
          lines.push("  Add analytics to .pi/telemetry.config.json to enable product signal detection.");
        } else {
          lines.push("Product success conditions: all met (or no data).");
        }
      } else {
        if (productOnly.length > 0) {
          lines.push(`### 📊 Product Signals (${productOnly.length})\n`);
          productOnly.forEach((s, i) => {
            const icon = s.severity === "high" ? "🔴" : "🟡";
            lines.push(`${i + 1}. ${icon} ${s.title}`);
            lines.push(`   ${s.description}`);
            lines.push(`   → ${s.suggestedAction}`);
            lines.push("");
          });
        }

        if (technicalOnly.length > 0) {
          lines.push(`### 🔧 Technical Signals (${technicalOnly.length})\n`);
          technicalOnly.forEach((s, i) => {
            const icon = s.severity === "high" ? "🔴" : s.severity === "medium" ? "🟡" : "🟢";
            lines.push(`${i + 1}. ${icon} [${s.source.toUpperCase()}] ${s.title}`);
            lines.push(`   ${s.description}`);
            lines.push(`   → ${s.suggestedAction}`);
            lines.push("");
          });
        }
      }

      if (errorOutput) {
        lines.push("─── Error tracker ───");
        lines.push(errorOutput.slice(0, 1000));
        lines.push("");
      }

      lines.push("Load signal-to-spec skill to determine the right BDD action for each signal.");
      lines.push("Present signals to the user for approval before creating any bug reports or specs.");

      ctx.ui.notify(`📡 Signal review complete: ${signals.length} signal(s) found`, "info");

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          signals,
          configured,
          rawLogs: logOutput.slice(0, 2000),
          rawErrors: errorOutput.slice(0, 2000),
          rawMetrics: metricsOutput.slice(0, 1000),
        },
      };
    },
  });

  // ── PostHog HogQL helper ──────────────────────────────────────────────────

  async function runHogQL(
    hogql: string,
    signal?: AbortSignal,
  ): Promise<{ columns: string[]; results: unknown[][]; error?: string }> {
    const cfg = config.analytics;
    if (!cfg) return { columns: [], results: [], error: "No analytics configured" };

    if (cfg.provider === "posthog") {
      const host = cfg.host ?? "https://app.posthog.com";
      const projectId = cfg.projectId;
      if (!projectId) return { columns: [], results: [], error: "PostHog projectId not set in telemetry.config.json" };

      const apiKeyVar = cfg.apiKeyEnvVar ?? "POSTHOG_API_KEY";
      const url = `${host}/api/projects/${projectId}/query/`;

      // Use curl — works everywhere, no SDK dependency
      const body = JSON.stringify({ query: { kind: "HogQLQuery", query: hogql } });
      const cmd =
        `curl -sf -X POST "${url}" ` +
        `-H "Authorization: Bearer $${apiKeyVar}" ` +
        `-H "Content-Type: application/json" ` +
        `-d '${body.replace(/'/g, "'\\''")}' 2>&1`;

      try {
        const result = await pi.exec("bash", ["-c", cmd], { signal, timeout: 30_000 });
        const raw = result.stdout.trim();
        const parsed = JSON.parse(raw);
        if (parsed.error) return { columns: [], results: [], error: parsed.error };
        return {
          columns: parsed.columns ?? [],
          results: parsed.results ?? [],
        };
      } catch (err) {
        return { columns: [], results: [], error: String(err) };
      }
    }

    if (cfg.provider === "custom") {
      const endpoint = cfg.queryEndpoint;
      if (!endpoint) return { columns: [], results: [], error: "Custom analytics: queryEndpoint not set" };
      const authVar = cfg.authHeaderEnvVar ?? "";
      const authHeader = authVar ? `-H "Authorization: $${authVar}"` : "";
      const body = JSON.stringify({ query: hogql });
      const cmd =
        `curl -sf -X POST "${endpoint}" ${authHeader} ` +
        `-H "Content-Type: application/json" ` +
        `-d '${body.replace(/'/g, "'\\''")}' 2>&1`;
      try {
        const result = await pi.exec("bash", ["-c", cmd], { signal, timeout: 30_000 });
        const parsed = JSON.parse(result.stdout.trim());
        return { columns: parsed.columns ?? [], results: parsed.results ?? [] };
      } catch (err) {
        return { columns: [], results: [], error: String(err) };
      }
    }

    return { columns: [], results: [], error: `Unknown analytics provider: ${cfg.provider}` };
  }

  // ── query_analytics ───────────────────────────────────────────────────────

  pi.registerTool({
    name: "query_analytics",
    label: "Query Analytics",
    description:
      "Run a HogQL query against the product analytics platform (PostHog). " +
      "HogQL is SQL over the PostHog event store — the same queries a human " +
      "would run in the PostHog UI can be run here programmatically. " +
      "Use to verify success conditions, analyse funnels, check feature adoption, " +
      "and understand user behaviour. Requires analytics configuration in .pi/telemetry.config.json.",
    promptSnippet: "Run a HogQL query against PostHog (funnel, adoption, success conditions)",
    promptGuidelines: [
      "Use query_analytics to verify success conditions defined in PRODUCT.md.",
      "HogQL is standard SQL over the events table: SELECT ... FROM events WHERE ...",
      "Key columns: event (event name), timestamp, distinct_id (user ID), properties (JSON).",
      "Use countIf(event = 'name') to count specific events.",
      "Use properties.field_name to access event properties.",
      "For funnel analysis, use multiple countIf expressions in a single query.",
      "The same query can be run and visualised in the PostHog UI for human review.",
      "Prefer check_success_conditions for automated PRODUCT.md validation.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description:
          "HogQL query (SQL dialect). Events table columns: " +
          "event, timestamp, distinct_id, properties (JSON). " +
          "Example: SELECT countIf(event='onboarding.completed') / countIf(event='onboarding.started') AS rate FROM events WHERE timestamp >= now() - interval 30 day",
      }),
      description: Type.Optional(Type.String({
        description: "What this query is checking — used in the output summary.",
      })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      if (!config.analytics) {
        return {
          content: [{ type: "text", text: "No analytics configured. Add an analytics section to .pi/telemetry.config.json." }],
          details: { configured: false },
        };
      }

      onUpdate?.({ content: [{ type: "text", text: `Running query${params.description ? `: ${params.description}` : ""}...` }] });

      const { columns, results, error } = await runHogQL(params.query, signal);

      if (error) {
        return {
          content: [{ type: "text", text: `Query failed: ${error}\n\nQuery was:\n${params.query}` }],
          details: { error, query: params.query },
        };
      }

      // Format results as a readable table
      const header = columns.join(" | ");
      const rows = results.slice(0, 50).map((row) =>
        (row as unknown[]).map((v) =>
          typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(4)) : String(v ?? "null")
        ).join(" | ")
      );
      const table = [header, "─".repeat(header.length), ...rows].join("\n");
      const truncated = results.length > 50 ? `\n\n(${results.length - 50} more rows not shown)` : "";

      const summary = params.description
        ? `${params.description}\n\n${table}${truncated}`
        : `${table}${truncated}`;

      return {
        content: [{ type: "text", text: summary }],
        details: { columns, results: results.slice(0, 50), rowCount: results.length, query: params.query },
      };
    },
  });

  // ── check_success_conditions ──────────────────────────────────────────────

  pi.registerTool({
    name: "check_success_conditions",
    label: "Check Success Conditions",
    description:
      "Read PRODUCT.md and verify whether deployed features are achieving their stated " +
      "product success conditions. For each condition, runs the associated HogQL query " +
      "against the analytics platform and compares the result against the target. " +
      "Returns: condition, target, current value, and status (met / not met / no data). " +
      "This is the primary tool for Gate 5 (measurement readiness) and ongoing product validation.",
    promptSnippet: "Verify PRODUCT.md success conditions against live production data",
    promptGuidelines: [
      "Call check_success_conditions after deployment to verify Gate 5 (measurement readiness).",
      "Call during /signal-review to identify which success conditions are not being met.",
      "If a condition shows 'no data', the telemetry spec may not be implemented — check with query_logs.",
      "If a condition shows 'not met', this is a product-level signal — load signal-to-spec for the BDD action.",
      "Success conditions are hypotheses. 'Not met' means the hypothesis is being refuted — not necessarily a bug.",
      "PRODUCT.md should include a hogql_query field in each telemetry spec for automatic checking.",
    ],
    parameters: Type.Object({
      feature: Type.Optional(Type.String({
        description: "Check only this feature's success conditions. If omitted, checks all deployed features.",
      })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!config.analytics) {
        return {
          content: [{
            type: "text",
            text: "No analytics configured. check_success_conditions requires analytics in .pi/telemetry.config.json.",
          }],
          details: { configured: false },
        };
      }

      if (!hasSuccessConditions(ctx.cwd)) {
        return {
          content: [{ type: "text", text: "No PRODUCT.md found or no success conditions defined. Use the measurement-design skill to add them." }],
          details: { configured: false },
        };
      }

      // Use shared parser — single source of truth for PRODUCT.md query extraction
      const allQueries = parseProductMdQueries(ctx.cwd);
      const filtered = params.feature
        ? allQueries.filter((q) => q.featureName.toLowerCase().includes(params.feature!.toLowerCase()))
        : allQueries;

      const results: Array<{
        feature: string;
        condition: string;
        query: string;
        target: number | null;
        current: number | null;
        status: "met" | "not_met" | "no_data" | "no_query";
        targetStr: string;
      }> = [];

      // Also check for features with conditions but no queries
      if (!hasHogQLQueries(ctx.cwd)) {
        results.push({
          feature: "All features",
          condition: "Success conditions defined but no HogQL queries embedded",
          query: "",
          target: null,
          current: null,
          status: "no_query",
          targetStr: "",
        });
      } else {
        for (const pq of filtered) {
          onUpdate?.({ content: [{ type: "text", text: `  Checking: ${pq.condition.slice(0, 60)}...` }] });

          const { results: queryResults, error } = await runHogQL(pq.query, signal);

          if (error || queryResults.length === 0) {
            results.push({ feature: pq.featureName, condition: pq.condition, query: pq.query, target: pq.target, current: null, status: "no_data", targetStr: pq.targetStr });
            continue;
          }

          const rawValue = queryResults[0]?.[0];
          const current = rawValue != null ? parseFloat(String(rawValue)) : null;

          let status: "met" | "not_met" | "no_data" = "no_data";
          if (current != null && pq.target != null) {
            status = current >= pq.target ? "met" : "not_met";
          }

          results.push({ feature: pq.featureName, condition: pq.condition, query: pq.query, target: pq.target, current, status, targetStr: pq.targetStr });
        }
      }

      if (results.length === 0) {
        return {
          content: [{
            type: "text",
            text: "No success conditions with HogQL queries found in PRODUCT.md.\n\n" +
              "Add HogQL queries to PRODUCT.md using the measurement-design skill. " +
              "Format:\n```sql\nSELECT count() / total AS rate FROM events ...\n-- target: 0.70\n```",
          }],
          details: { results: [] },
        };
      }

      // Format output
      const lines = ["## Success Condition Report\n"];
      const met = results.filter((r) => r.status === "met");
      const notMet = results.filter((r) => r.status === "not_met");
      const noData = results.filter((r) => r.status === "no_data");
      const noQuery = results.filter((r) => r.status === "no_query");

      if (notMet.length > 0) {
        lines.push("### ❌ Not Met");
        for (const r of notMet) {
          lines.push(`**${r.feature}:** ${r.condition}`);
          lines.push(`  Current: ${r.current?.toFixed(3)} | Target: ${r.targetStr}`);
          lines.push(`  → Load signal-to-spec to determine the BDD action`);
          lines.push("");
        }
      }

      if (met.length > 0) {
        lines.push("### ✅ Met");
        for (const r of met) {
          lines.push(`**${r.feature}:** ${r.condition}`);
          lines.push(`  Current: ${r.current?.toFixed(3)} | Target: ${r.targetStr}`);
          lines.push("");
        }
      }

      if (noData.length > 0) {
        lines.push("### ⚪ No Data");
        for (const r of noData) {
          lines.push(`**${r.feature}:** ${r.condition}`);
          lines.push(`  → Check with query_logs that events are being emitted`);
          lines.push("");
        }
      }

      if (noQuery.length > 0) {
        lines.push("### 📝 No Query Defined");
        for (const r of noQuery) {
          lines.push(`**${r.feature}:** Success conditions defined but no HogQL query in PRODUCT.md`);
          lines.push(`  → Use measurement-design skill to add the query`);
          lines.push("");
        }
      }

      lines.push(`─────`);
      lines.push(`${met.length} met | ${notMet.length} not met | ${noData.length} no data | ${noQuery.length} no query`);

      const signals: Signal[] = notMet.map((r) => ({
        source: "metrics" as const,
        severity: "high" as const,
        title: `Success condition not met: ${r.condition.slice(0, 80)}`,
        description: `${r.feature}: current ${r.current?.toFixed(3)}, target ${r.targetStr}`,
        suggestedAction: "This is a product-level signal. Load signal-to-spec for the appropriate BDD action.",
      }));

      if (signals.length > 0) {
        pi.events.emit("telemetry:product_signals", { signals });
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { results, met: met.length, notMet: notMet.length, noData: noData.length },
      };
    },
  });

  // ── /telemetry command ────────────────────────────────────────────────────

  pi.registerCommand("telemetry", {
    description: "Show current telemetry configuration",
    handler: async (_args, ctx) => {
      if (Object.keys(config).length === 0) {
        ctx.ui.notify(
          "No telemetry configured. Create .pi/telemetry.config.json — see templates/telemetry.config.json for the format.",
          "warning",
        );
        return;
      }
      const lines = Object.entries(config).map(([source, cfg]) =>
        `${source}: ${(cfg as { provider?: string }).provider ?? "configured"}`
      );
      ctx.ui.notify(`Telemetry configuration:\n${lines.join("\n")}`, "info");
    },
  });
}
