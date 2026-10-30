# AWS stub

A local stand-in for the AWS and Kubernetes APIs that Swan's connections work with, so they can be developed and tested without an AWS account. Nothing here talks to AWS.

```bash
pnpm aws-stub              # http://127.0.0.1:4590
pnpm aws-stub --tls        # HTTPS with a throwaway CA (needed for kubectl)
```

The start-up message prints ready-to-paste environment variables for the AWS CLI and kubectl.

## What it implements

| Area | Operations | Notes |
| --- | --- | --- |
| Signing | SigV4 header auth and presigned URLs | Verified with `@ph/aws-sigv4`; wrong keys, expired sessions, skew and body tampering fail like AWS does |
| STS | `GetCallerIdentity`, `AssumeRole` | Roles `ReadOnly` and `Developer` in account `000000000000` |
| S3 | List buckets/objects, Put/Get/Head/Delete object, Create/Delete bucket | Path-style; accepts `aws-chunked` bodies and SDK checksum trailers |
| CloudWatch Logs | `DescribeLogGroups`, `DescribeLogStreams`, `FilterLogEvents`, `GetLogEvents`, `CreateLogGroup`, `DeleteLogGroup` | JSON 1.1 with `X-Amz-Target` |
| EKS | `ListClusters`, `DescribeCluster` | One cluster, `swan-dev`, whose endpoint is the stub's Kubernetes API |
| Kubernetes | Discovery, namespaces, pods (+ logs), deployments, configmaps, secrets; get/list/watch/create/patch/update/delete | Authenticates EKS tokens (`k8s-aws-v1.` presigned GetCallerIdentity bound to the cluster name); returns tables for `kubectl get` |
| Sign-in | OAuth device-code flow at `/sso/*`, role credentials | For the reference connection wrapper |

`ReadOnly` may only read: S3 and Logs writes return `AccessDenied`, and in Kubernetes it behaves like the built-in `view` role (read verbs, no secrets). Every authenticated call is recorded at `GET /_stub/requests` with its action and whether it was allowed.

Built-in keys (they only work against the stub): `AKIASWANSTUB00000001` / `swanStubSecretKey00000000000000000000001`.

## Reference connection wrapper

`bin/swan-stub-connection` implements Swan's connection protocol v1 ([schema](../../docs/connection-protocol-v1.schema.json)) against the stub's sign-in flow:

```bash
tools/aws-stub/bin/swan-stub-connection login --stub http://127.0.0.1:4590 --role ReadOnly
```

It prints a `device_code` line, waits for approval (open the link, or `POST /_stub/sso/approve {"user_code": "…"}`, or start the stub with `--auto-approve`), then a `result` line with:

- an `aws-sigv4` credential (temporary role keys) and a `bearer` EKS token,
- `~/.aws/config`, `~/.aws/credentials` and `~/.kube/config` with `{{credential:…}}` references instead of values,
- `AWS_PROFILE` and `KUBECONFIG`.

`status` and `renew` reuse the refresh token kept in the working directory, and answer `login_required` when it has expired. Use it as the template for a wrapper around a real sign-in tool.

## Test controls

| Endpoint | Effect |
| --- | --- |
| `POST /_stub/reset` | Restore the seeded data and forget sessions |
| `POST /_stub/sso/approve` `{"user_code": "…"}` | Approve a pending device code |
| `GET /_stub/requests` | Calls made so far, with action and decision |

Options: `--port`, `--host`, `--tls`, `--auto-approve`, `--session-seconds`, `--access-seconds`, `--refresh-seconds` (short values exercise renewal).
