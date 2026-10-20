-- The cache's actual value, by tenant and by model.
-- `saved_latency_ms` is the honest number: a cache hit has no `model_latency_ms`, so it
-- compares against the warm p50 for the same tenant rather than against nothing.
WITH warm AS (
  SELECT tenant, model, approx_percentile(model_latency_ms, 0.5) AS warm_p50_ms
  FROM gw_usage
  WHERE day >= date_format(date_add('day', -7, current_date), '%Y-%m-%d')
    AND NOT cold_start
    AND model_latency_ms IS NOT NULL
  GROUP BY tenant, model
)
SELECT
  w.tenant,
  w.model,
  count(*)                                                       AS requests,
  sum(CASE WHEN gw.cache = 'hit-l0' THEN 1 ELSE 0 END)           AS l0_hits,
  sum(CASE WHEN gw.cache = 'hit-l1' THEN 1 ELSE 0 END)           AS l1_hits,
  sum(CASE WHEN gw.cache = 'miss' THEN 1 ELSE 0 END)             AS misses,
  round(100.0 * sum(CASE WHEN gw.cache <> 'miss' THEN 1 ELSE 0 END) / count(*), 1) AS hit_rate_pct,
  round(sum(CASE WHEN gw.cache <> 'miss' THEN w.warm_p50_ms ELSE 0 END) / 1000.0, 1) AS saved_seconds
FROM gw_usage AS gw
JOIN warm AS w ON w.tenant = gw.tenant AND w.model = gw.model
WHERE gw.day >= date_format(date_add('day', -7, current_date), '%Y-%m-%d')
GROUP BY 1, 2
ORDER BY saved_seconds DESC;
