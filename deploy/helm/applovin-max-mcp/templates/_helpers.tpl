{{- define "amm.name" -}}{{ .Chart.Name }}{{- end -}}
{{- define "amm.fullname" -}}{{ printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}{{- end -}}
{{- define "amm.labels" -}}
app.kubernetes.io/name: {{ include "amm.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
{{- define "amm.selector" -}}
app.kubernetes.io/name: {{ include "amm.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
{{- define "amm.serviceAccount" -}}{{ default (include "amm.fullname" .) .Values.serviceAccount.name }}{{- end -}}
