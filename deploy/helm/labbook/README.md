# labbook Helm chart

Deploys labbook, the test-results lab book:

- a `Deployment` and `Service` named after the release (one Node container on port 8080);
- a CloudNativePG `Cluster` `<release>-db` (`postgresql.enabled`; the CNPG operator must be installed);
- a `pg_dump` `CronJob` `<release>-pg-dump` writing to the PVC `<release>-dumps` (`backups.enabled`);
- optionally an `Ingress` and a cert-manager `Certificate` for its TLS Secret (`ingress.enabled`).

It creates no cluster-scoped objects and no Secrets: create the namespace first.

## Prerequisite: the admin Secret

The first admin is seeded from an operator-created Secret while the users table is empty; the
chart only references it (`admin.secretName`, default `<release>-admin`, keys `username` and
`password`):

```bash
kubectl -n labbook create secret generic labbook-admin \
  --from-literal=username=admin --from-literal=password="$(openssl rand -base64 30 | tr -d '/+=\n' | cut -c1-28)"
```

## Key values

| Value                                                            | Meaning                                                                |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `image.ref`                                                      | Full reference `repo:tag@sha256:…`; wins over `repository/tag/digest`. |
| `replicas`, `resources`                                          | The app Deployment.                                                    |
| `limits.maxAttachmentBytes`, `limits.maxBodyBytes`               | `MAX_ATTACHMENT_BYTES`, `MAX_BODY_BYTES`.                              |
| `extraEnv`                                                       | Extra container env entries.                                           |
| `admin.secretName`                                               | The existing admin Secret.                                             |
| `ingress.enabled`, `.className`, `.host`, `.annotations`         | The Ingress.                                                           |
| `ingress.tls.secretName`, `ingress.tls.certificate.*`            | TLS Secret and the cert-manager issuer that fills it.                  |
| `postgresql.instances`, `.storage.size`, `.storage.storageClass` | The CNPG Cluster; also `inheritedMetadata`, `parameters`, `resources`. |
| `backups.schedule`, `.retentionDays`, `.storage.*`               | The dump CronJob and its PVC.                                          |
| `keepData`                                                       | `helm.sh/resource-policy: keep` on the Cluster and the dumps PVC.      |

The Deployment selector is `app.kubernetes.io/name: <release>` only. It is immutable, so the
chart keeps it (and the pod labels) exactly as the earlier kustomize overlay created them.

## kw

kw deploys this chart through Kuvryn Sync as release `labbook` in namespace `labbook` with
[`values-kw.yaml`](values-kw.yaml); do not `helm install` it there by hand. CI writes each new
`image.tag` there after the image is pushed; nobody edits it by hand. Render locally with:

```bash
helm template labbook deploy/helm/labbook -n labbook -f deploy/helm/labbook/values-kw.yaml
```
