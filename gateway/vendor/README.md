# Vendored dependencies

These files ship inside the Lambda asset, which is `gateway/` copied **verbatim** — there is
no bundler, so anything the handler imports at runtime has to be present in this directory.

## `aws4fetch.mjs` + `aws4fetch.d.mts`

- **Source:** https://github.com/mhart/aws4fetch, `dist/aws4fetch.esm.mjs` and `dist/main.d.mts`
- **Version:** 1.0.20
- **License:** MIT — see `aws4fetch.LICENSE`

Why it is here: the gateway originally SigV4-signed its calls to the decider when it was
exposed as a Lambda Function URL (`AuthType: AWS_IAM`). The model is now an internal ALB
(no IAM auth on that hop), so `aws4fetch` is no longer used in the hot path. It remains
vendored for any future IAM-authenticated upstream. `aws4fetch` stays a devDependency so
`tests/unit/` can assert our copy signs byte-identically to the published one.
