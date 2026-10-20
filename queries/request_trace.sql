-- Join the two streams on request_id.
-- The gateway knows what the caller did; the model knows what it cost. They are separate
-- delivery streams (and separate Athena tables) precisely so a gap between them is visible:
-- a request in gw_usage with no matching model_inference row never reached the model.
SELECT
  g.request_id,
  g.ts,
  g.tenant,
  g.model,
  g.cache,
  g.latency_ms      AS gateway_latency_ms,
  m.latency_ms      AS model_total_ms,
  m.model_load_ms,
  m.cold_start,
  g.confidence_floor,
  g.bands
FROM gw_usage AS g
LEFT JOIN model_inference AS m ON m.request_id = g.request_id
WHERE g.day >= date_format(date_add('day', -1, current_date), '%Y-%m-%d')
  AND g.cache = 'miss'
ORDER BY g.latency_ms DESC
LIMIT 200;
