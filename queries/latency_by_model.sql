-- Latency, split into the part the model owns and the part the gateway owns.
-- If `gateway_ms` is large, the problem is this stack, not the checkpoint.
SELECT
  model,
  count(*)                                   AS requests,
  round(avg(latency_ms))                     AS avg_total_ms,
  approx_percentile(latency_ms, 0.50)        AS p50_ms,
  approx_percentile(latency_ms, 0.95)        AS p95_ms,
  approx_percentile(latency_ms, 0.99)        AS p99_ms,
  round(avg(model_latency_ms))               AS avg_model_ms,
  round(avg(model_latency_ms - model_load_ms)) AS avg_inference_ms,
  round(avg(model_load_ms))                  AS avg_load_ms
FROM gw_usage
WHERE day >= date_format(date_add('day', -3, current_date), '%Y-%m-%d')
GROUP BY model
ORDER BY p95_ms DESC;
