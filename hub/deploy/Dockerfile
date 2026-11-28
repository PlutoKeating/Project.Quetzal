# syntax=docker/dockerfile:1
# SPDX-License-Identifier: AGPL-3.0-only
#
# quetzalcoatl-hub 的容器镜像。构建上下文是 hub/ 目录（本文件的上一级）：
#
#   docker build -f deploy/Dockerfile --build-arg VERSION=2.0.0 -t quetzalcoatl-hub:2.0.0 .
#
# 最终镜像只有一个静态二进制、CA 根证书和两个空目录，以非 root 用户运行。

ARG GO_VERSION=1.26

FROM --platform=$BUILDPLATFORM golang:${GO_VERSION} AS build
ARG TARGETOS=linux
ARG TARGETARCH
# 写进 /v1/meta 的 server_version 与指标 quetzalcoatl_hub_build_info；不传则显示 dev。
ARG VERSION=
# 拉不到 proxy.golang.org 的网络可以换成镜像，例如 --build-arg GOPROXY=https://goproxy.cn,direct。
ARG GOPROXY=https://proxy.golang.org,direct
ENV GOPROXY=${GOPROXY}
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" \
    -o /out/quetzalcoatl-hub ./cmd/quetzalcoatl-hub
# 最终镜像里没有 shell，目录只能在这里建好再整体拷过去。
# 具名卷首次挂载时继承数据目录的属主与权限，所以现在就交给运行用户。
RUN mkdir -p /out/rootfs/tmp /out/rootfs/var/lib/quetzalcoatl-hub \
    && chmod 1777 /out/rootfs/tmp \
    && chmod 0700 /out/rootfs/var/lib/quetzalcoatl-hub \
    && chown 65532:65532 /out/rootfs/var/lib/quetzalcoatl-hub

FROM scratch
# 访问对象存储（HTTPS）需要 CA 根证书。
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/quetzalcoatl-hub /usr/local/bin/quetzalcoatl-hub
COPY --from=build /out/rootfs/ /
USER 65532:65532
WORKDIR /var/lib/quetzalcoatl-hub
ENV QUETZALCOATL_HUB_ADDR=0.0.0.0:8443 \
    QUETZALCOATL_HUB_DATA_DIR=/var/lib/quetzalcoatl-hub
VOLUME ["/var/lib/quetzalcoatl-hub"]
EXPOSE 8443/tcp 7842/udp
# 镜像里没有 shell 和 curl，由二进制自己请求本机的 /healthz。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/usr/local/bin/quetzalcoatl-hub", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/quetzalcoatl-hub"]
