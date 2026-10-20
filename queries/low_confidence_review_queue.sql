-- The 10% of questions the model is least sure about, worst first.
-- This is the review queue: send these to a human or a bigger model, and leave the rest alone.
SELECT
  ts,
  request_id,
  tenant,
  model,
  confidence_floor,
  questions,
  cache,
  answers
FROM gw_usage
WHERE day >= date_format(date_add('day', -7, current_date), '%Y-%m-%d')
  AND confidence_floor IS NOT NULL
ORDER BY confidence_floor ASC
LIMIT 100;
