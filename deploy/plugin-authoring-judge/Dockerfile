# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
FROM --platform=linux/amd64 node@sha256:1a6a7b2e2e2c80a6973f57aa8b0c6ad67a961ddbc5ef326c448e133f93564ff9 AS build

WORKDIR /build
COPY LICENSE package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY deploy/plugin-authoring-judge/package.json ./deploy/plugin-authoring-judge/package.json
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm --filter @tenantscript/cli... build
RUN pnpm --filter @tenantscript/plugin-authoring-judge-image deploy --prod --legacy /runtime
COPY scripts ./scripts
COPY evals ./evals
RUN rm -rf packages/test-config && \
    find packages -type d \( -name src -o -name test \) -prune -exec rm -rf '{}' + && \
    find packages -type f -name 'tsconfig*.json' -delete && \
    chmod -R a+rX packages /runtime/node_modules scripts evals

FROM --platform=linux/amd64 gcr.io/distroless/nodejs24-debian13@sha256:e251b09ca1d32d7ae2dcba1721370cde41b5c69713edbb99bc644c6e4e101d2f AS runtime

FROM runtime

ARG SOURCE_REVISION
LABEL org.opencontainers.image.source="https://github.com/albert-einshutoin/TenantScript" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.title="TenantScript plugin authoring judge"

WORKDIR /opt/tenantscript/repository
COPY --from=build --chown=root:root /runtime/node_modules ./node_modules
COPY --from=build --chown=root:root /build/packages ./packages
COPY --from=build --chown=root:root /build/scripts ./scripts
COPY --from=build --chown=root:root /build/evals ./evals

ENV HOME=/nonexistent \
    NODE_ENV=production \
    NO_COLOR=1 \
    TZ=UTC
USER 65532:65532
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["/opt/tenantscript/repository/scripts/plugin-authoring-judge-entrypoint.mjs"]
