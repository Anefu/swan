// pnpm aws-stub [--port 4590] [--tls] [--auto-approve] [--session-seconds 3600] [--refresh-seconds 28800]
import { parseArgs } from "node:util";
import { startStub } from "./server.js";
import { STUB_USER } from "./state.js";
import { makeTls } from "./tls.js";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "4590" },
    host: { type: "string", default: "127.0.0.1" },
    tls: { type: "boolean", default: false },
    "auto-approve": { type: "boolean", default: false },
    "session-seconds": { type: "string", default: "3600" },
    "access-seconds": { type: "string", default: "3600" },
    "refresh-seconds": { type: "string", default: "28800" },
  },
});

const tls = values.tls ? makeTls() : undefined;
const stub = await startStub({
  port: Number(values.port),
  host: values.host,
  tls,
  autoApprove: values["auto-approve"],
  sessionSeconds: Number(values["session-seconds"]),
  accessTokenSeconds: Number(values["access-seconds"]),
  refreshTokenSeconds: Number(values["refresh-seconds"]),
});

console.log(`AWS stub on ${stub.url}${tls ? ` (CA: ${tls.caFile})` : ""}

AWS CLI:
  export AWS_ACCESS_KEY_ID=${STUB_USER.accessKeyId} AWS_SECRET_ACCESS_KEY=${STUB_USER.secretAccessKey} AWS_REGION=us-east-1 AWS_ENDPOINT_URL=${stub.url}${tls ? ` AWS_CA_BUNDLE=${tls.caFile}` : ""}
  aws sts get-caller-identity
  aws sts assume-role --role-arn arn:aws:iam::000000000000:role/ReadOnly --role-session-name me
  aws s3 ls s3://swan-demo
  aws logs filter-log-events --log-group-name /swan/payments

kubectl (needs --tls: kubectl only sends exec-plugin tokens over HTTPS):
  aws eks update-kubeconfig --name swan-dev --kubeconfig /tmp/swan-stub-kubeconfig
  KUBECONFIG=/tmp/swan-stub-kubeconfig kubectl get pods -A

Connection wrapper (protocol v1):
  tools/aws-stub/bin/swan-stub-connection login --stub ${stub.url}
  Approve at the printed link${values["auto-approve"] ? " (auto-approved)" : ""}, or: curl -X POST ${stub.url}/_stub/sso/approve -d '{"user_code":"XXXX-XXXX"}'
`);

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void stub.close().then(() => process.exit(0)));
