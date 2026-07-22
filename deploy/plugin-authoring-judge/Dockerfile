# syntax=docker/dockerfile:1.7
FROM --platform=linux/amd64 node@sha256:1a6a7b2e2e2c80a6973f57aa8b0c6ad67a961ddbc5ef326c448e133f93564ff9 AS build

WORKDIR /build
COPY LICENSE package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY deploy/plugin-authoring-judge/package.json ./deploy/plugin-authoring-judge/package.json
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm --filter @tenantscript/cli... build
RUN find packages -type d \( -name src -o -name test \) -prune -exec rm -rf '{}' + && \
    find packages -type f -name 'tsconfig*.json' -delete && \
    chmod -R a+rX packages node_modules

FROM --platform=linux/amd64 node@sha256:1a6a7b2e2e2c80a6973f57aa8b0c6ad67a961ddbc5ef326c448e133f93564ff9

ARG SOURCE_REVISION
LABEL org.opencontainers.image.source="https://github.com/albert-einshutoin/TenantScript" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.title="TenantScript plugin authoring judge"

WORKDIR /opt/tenantscript/repository
COPY --from=build --chown=root:root /build/node_modules ./node_modules
COPY --from=build --chown=root:root /build/packages ./packages
COPY --chown=root:root scripts ./scripts
COPY --chown=root:root evals ./evals
COPY --chown=root:root deploy/plugin-authoring-judge/plugin-authoring-judge /opt/tenantscript/bin/plugin-authoring-judge
RUN chmod -R a+rX ./scripts ./evals /opt/tenantscript/bin

ENV HOME=/nonexistent \
    NODE_ENV=production \
    NO_COLOR=1 \
    TZ=UTC
USER node
ENTRYPOINT ["/opt/tenantscript/bin/plugin-authoring-judge"]
