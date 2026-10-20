-- Where the gateway stops being a proxy and starts making decisions.
-- `band` comes from the caller's own act/review/escalate thresholds, so this is the
-- distribution of *automated actions taken*, not of model outputs.
SELECT
  json_extract_scalar(bands, '$."deploy"')    AS band,   -- rename to your own question
  count(*)                                    AS requests,
  round(avg(confidence_floor), 3)             AS avg_confidence_floor,
  approx_percentile(confidence_floor, 0.10)   AS p10_confidence_floor,
  sum(CASE WHEN cache <> 'miss' THEN 1 ELSE 0 END) AS cached
FROM gw_usage
WHERE day >= date_format(date_add('day', -7, current_date), '%Y-%m-%d')
  AND bands IS NOT NULL
GROUP BY 1
ORDER BY requests DESC;
