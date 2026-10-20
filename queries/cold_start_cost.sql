-- The cold-start bill, by hour.
-- A cold start is 25-60 s of billed wall time on a 10 GB function. Ten of them cost more
-- than a thousand warm requests, so this is the first place to look when the invoice moves.
SELECT
  date_trunc('hour', from_iso8601_timestamp(ts)) AS hour,
  tenant,
  count(*)                                       AS cold_starts,
  round(sum(model_load_ms) / 1000.0, 1)          AS total_load_seconds,
  round(avg(latency_ms))                         AS avg_cold_latency_ms,
  -- What those same requests would have cost warm, as a fraction of what they did cost.
  round(avg(latency_ms) / nullif(avg(CASE WHEN NOT cold_start THEN latency_ms END), 0), 2) AS times_warm_latency
FROM gw_usage
WHERE cold_start AND day >= date_format(date_add('day', -7, current_date), '%Y-%m-%d')
GROUP BY 1, 2
ORDER BY cold_starts DESC;
