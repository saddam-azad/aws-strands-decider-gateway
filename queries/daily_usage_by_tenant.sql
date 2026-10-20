-- Who is using the gateway, and how much?
-- One row per tenant per day. Start here: almost every other question is a refinement.
SELECT
  day,
  tenant,
  model,
  count(*)                AS requests,
  sum(input_tokens)       AS input_tokens,
  sum(output_tokens)      AS output_tokens,
  round(avg(latency_ms))  AS avg_latency_ms,
  approx_percentile(latency_ms, 0.95) AS p95_latency_ms,
  sum(CASE WHEN cold_start THEN 1 ELSE 0 END) AS cold_starts
FROM gw_usage
WHERE day >= date_format(date_add('day', -7, current_date), '%Y-%m-%d')
GROUP BY day, tenant, model
ORDER BY day DESC, requests DESC;
