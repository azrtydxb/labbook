{{/*
Every object is named after the release (labbook, labbook-db, labbook-dumps, ...), so a
release called `labbook` adopts the objects the kustomize overlay created.
*/}}
{{- define "labbook.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/*
Object labels. Call with (dict "ctx" $ "name" "<app.kubernetes.io/name>").
*/}}
{{- define "labbook.labels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/part-of: {{ include "labbook.fullname" .ctx }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/version: {{ .ctx.Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .ctx.Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .ctx.Chart.Name .ctx.Chart.Version }}
{{- end -}}

{{/*
The Deployment selector. It is immutable and predates the chart, so it carries only
app.kubernetes.io/name; do not add labels here.
*/}}
{{- define "labbook.selectorLabels" -}}
app.kubernetes.io/name: {{ include "labbook.fullname" . }}
{{- end -}}

{{/*
Pod labels: the selector plus part-of, exactly as before the chart. Adding labels here
restarts every pod.
*/}}
{{- define "labbook.podLabels" -}}
{{ include "labbook.selectorLabels" . }}
app.kubernetes.io/part-of: {{ include "labbook.fullname" . }}
{{- end -}}

{{/*
The container image: image.ref verbatim when set, else repository[:tag][@digest], the
tag defaulting to the chart's appVersion when neither tag nor digest is given.
*/}}
{{- define "labbook.image" -}}
{{- if .Values.image.ref -}}
{{- .Values.image.ref -}}
{{- else -}}
{{- $repo := required "image.ref or image.repository is required" .Values.image.repository -}}
{{- $tag := .Values.image.tag -}}
{{- if and (not $tag) (not .Values.image.digest) -}}
{{- $tag = .Chart.AppVersion -}}
{{- end -}}
{{- $repo -}}
{{- with $tag }}:{{ . }}{{ end -}}
{{- with .Values.image.digest }}@{{ . }}{{ end -}}
{{- end -}}
{{- end -}}

{{/* The Secret CloudNativePG generates for the application owner (uri, username, ...). */}}
{{- define "labbook.dbSecretName" -}}
{{- .Values.database.secretName | default (printf "%s-db-app" (include "labbook.fullname" .)) -}}
{{- end -}}

{{- define "labbook.adminSecretName" -}}
{{- .Values.admin.secretName | default (printf "%s-admin" (include "labbook.fullname" .)) -}}
{{- end -}}

{{- define "labbook.tlsSecretName" -}}
{{- .Values.ingress.tls.secretName | default (printf "%s-tls" (include "labbook.fullname" .)) -}}
{{- end -}}
