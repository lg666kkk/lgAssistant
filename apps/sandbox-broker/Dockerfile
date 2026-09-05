FROM golang:1.26-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/sandbox-broker ./cmd/broker
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/sandbox-worker ./cmd/worker

FROM gcr.io/distroless/static-debian12:nonroot AS broker
COPY --from=build /out/sandbox-broker /sandbox-broker
USER 65532:65532
ENTRYPOINT ["/sandbox-broker"]

FROM scratch AS worker-binary
COPY --from=build /out/sandbox-worker /sandbox-worker
