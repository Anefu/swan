# Credentials and connections

Agents never see a secret. Every credential an agent can use comes from a **connection** in
`~/.swan/config.yaml`; its value lives in `~/.swan/secrets.yaml` (or comes from a sign-in tool).
Inside the sandbox the agent gets a placeholder. Swan's egress proxy swaps in the real value only on
HTTPS requests to the credential's hosts, and only for requests the persona's rules allow; values a
server echoes back are turned into placeholders again.

A complete, commented example of all three files is in [examples/reference/](../examples/reference/).

## Defining credentials

```yaml
# config.yaml (no values here)
connections:
  github:
    type: static                       # values from secrets.yaml / secrets.env
    credentials:
      GITHUB_TOKEN:
        hosts: [api.github.com]
        inject: { header: Authorization, format: "Bearer {value}" }   # optional
  corp-aws:
    type: command                      # a wrapper that speaks protocol v1
    command: [~/bin/corp-swan, --role, ReadOnly]
    hosts: ["*.amazonaws.com"]         # upper bound for every credential it returns
```

```yaml
# secrets.yaml
github/GITHUB_TOKEN: github_pat_…
```

Values can also go in `secrets.env` (`GITHUB__GITHUB_TOKEN=…`: the connection in capitals with
dashes as underscores, then `__` and the name), or be added in Swan settings → Connections (the swan icon at the top right).
Both files and the `connections` block are watched: the next request uses a new value, with no
restart.

## Letting a persona use them

```yaml
# persona
connections:
  github:
    rules:
      - { credential: GITHUB_TOKEN, api: http, allow: ["GET /**"], ask: ["POST /repos/*/*/issues"] }
  corp-aws:
    rules:
      - { credential: prod-eks, api: kubernetes, allow: ["get *", "list *", "watch *"], deny: ["* secrets"] }
      - { credential: prod-aws, api: aws, allow: ["sts:GetCallerIdentity", "s3:Get*", "logs:*"] }
```

Rule forms: `kubernetes` `<verb> <resource>[/<sub>] [in <namespace>]`; `aws` `service:Action`;
`http` `METHOD /path` (`*` within a segment, `**` across). Deny wins over ask, ask over allow. A
request no rule matches goes out with the placeholder (so it fails upstream) and the conversation
shows a "Blocked …" notice with **Add rule…**. An ask rule pauses the request on an approval card.

Only this persona's credentials reach a credential's hosts. A request there that carries any other
credential (a token or AWS key the agent found or was given, in `Authorization`, an AWS signature or
presigned URL, a header like `X-Api-Key`, or a query token) is refused, and the conversation says
so once per host: an agent given someone else's token could otherwise send your data to their
account. Requests without credentials still go through. If a host needs another credential, such
as a registry token kept in a repository, list it under Settings → Allowed hosts → Other credentials
allowed (`network.otherCredentials`).

## Sign-in tools (command connections)

A command connection runs a small wrapper around your own sign-in tool (an SSO helper, a cloud CLI,
a registry login) on your Mac: `<command> status|login|renew`, `{"protocol":1,…}` on stdin, JSON
Lines on stdout, as defined by [connection-protocol-v1.schema.json](connection-protocol-v1.schema.json).
Swan shows its device-code sign-in in the conversation, keeps the values on the host and renews them
before they expire.

Credential kinds are `bearer`, `header`, `basic` and `aws-sigv4`. Files the wrapper returns (for
example `~/.aws/credentials`, `~/.kube/config`) are written into the sandbox home with placeholders,
and its environment applies to every new shell. For AWS, the sandbox signs requests with placeholder
keys and the proxy checks that signature and re-signs with the real session credentials, so the AWS
CLI and SDKs work unmodified.

[tools/aws-stub](../tools/aws-stub/) has a reference wrapper and a local AWS and Kubernetes
stand-in for trying this without an AWS account.

## Upgrading from the format before connections

Swan no longer converts credentials with `hosts` in the secrets files, personas with
`credentials: [...]`, or `{{secret:NAME}}` references. To bring an install that still uses them
forward, run Swan 0.3 once, which converts them, then update.
