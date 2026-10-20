# Vendored dependencies

These files ship inside the Lambda asset, which is `gateway/` copied **verbatim** — there is
no bundler, so anything the handler imports at runtime has to be present in this directory.

## `aws4fetch.mjs` + `aws4fetch.d.mts`

- **Source:** https://github.com/mhart/aws4fetch, `dist/aws4fetch.esm.mjs` and `dist/main.d.mts`
- **Version:** 1.0.20
- **License:** MIT — see `aws4fetch.LICENSE`

Why it is here: the gateway SigV4-signs its calls to the decider Function URL
(`AuthType: AWS_IAM`), which needs a signer inside the Lambda. `aws4fetch` is a single
dependency-free file with published type declarations, so vendoring it costs ~11 KB and
keeps the "no build step" property intact. The `aws4fetch` package stays a devDependency so
`tests/unit/sigv4.test.ts` can assert our copy signs byte-identically to the published one.

Do not edit these files by hand — replace them wholesale on upgrade and re-run the signature
test.
