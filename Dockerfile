# Standalone T3 Cloud image. Source and provider versions are pinned in t3-source/source.json.
# Supply BASE by digest and GitHub asset SHA256 values from the release workflow.
ARG BASE=ghcr.io/briq-cloud/sandbox@sha256:1791ed759c6ecdc18546b76541194b60a4c25b2bf8e205de28476c0bf54c3e6d
FROM ${BASE} AS native-clis

ARG CLAUDE_VERSION=2.1.276
ARG CODEX_VERSION=0.166.0
ARG TTYD_VERSION=1.7.7

# One line per download: what, its sha256, how it was checked.
RUN mkdir -p /etc/t3-cloud && : > /etc/t3-cloud/downloads

# Updates off, for every process: the variables each CLI reads, and the system-wide config files
# they read before the person's own (which live on the briq's volume, empty at build).
# BROWSER, and xdg-open below: there is no browser here, so a CLI that opens a link shows it instead.
ENV DISABLE_AUTOUPDATER=1 \
    DISABLE_UPDATES=1 \
    BROWSER=/usr/local/bin/show-url

# Claude Code: the native binary and its checksum, from the bucket its installer reads.
RUN B=https://downloads.claude.ai/claude-code-releases \
  && V="${CLAUDE_VERSION:-$(curl -fsSL "$B/stable")}" \
  && curl -fsSL "$B/$V/linux-x64/claude" -o /usr/local/bin/claude \
  && H="$(curl -fsSL "$B/$V/manifest.json" | jq -r '.platforms["linux-x64"].checksum')" \
  && echo "$H  /usr/local/bin/claude" | sha256sum -c - \
  && printf 'Claude Code\t%s\tits release manifest\n' "$H" >> /etc/t3-cloud/downloads \
  && chmod 755 /usr/local/bin/claude \
  && mkdir -p /etc/claude-code \
  && echo '{"env":{"DISABLE_AUTOUPDATER":"1","DISABLE_UPDATES":"1"}}' > /etc/claude-code/managed-settings.json

# A GitHub release asset's sha256, as GitHub computed it at upload: `gh-digest owner/repo tag name`.
# The build passes each one in (resolved with its token); a local build asks the API.
COPY bin/gh-digest /usr/local/bin/gh-digest

# Codex: its release package, as published (the binary, the code-mode host that runs its tools,
# its bwrap and rg), under /opt/codex; the sign-in in a file under CODEX_HOME.
ARG CODEX_SHA256=
RUN V="${CODEX_VERSION:?Codex requires an explicit version}" \
  && A=codex-package-x86_64-unknown-linux-musl.tar.gz \
  && H="${CODEX_SHA256:-$(gh-digest openai/codex "rust-v${V}" "$A")}" \
  && curl -fsSL "https://github.com/openai/codex/releases/download/rust-v${V}/$A" -o "/tmp/$A" \
  && echo "$H  /tmp/$A" | sha256sum -c - \
  && printf 'Codex\t%s\tthe GitHub release digest\n' "$H" >> /etc/t3-cloud/downloads \
  && mkdir -p /opt/codex && tar -xzf "/tmp/$A" -C /opt/codex && rm "/tmp/$A" \
  && ln -s /opt/codex/bin/codex /usr/local/bin/codex \
  && test "$(codex --version)" = "codex-cli ${V}" \
  && printf '%s\n' "$V" > /etc/t3-cloud/codex-version \
  && mkdir -p /etc/codex \
  && printf 'check_for_update_on_startup = false\ncli_auth_credentials_store = "file"\n' > /etc/codex/config.toml

# Briq CLI: the native browser login and cloud commands, with an exact locked dependency closure.
COPY briq-cli /opt/briq-cli
RUN cd /opt/briq-cli && npm ci --ignore-scripts --no-fund --no-audit \
  && ln -s /opt/briq-cli/node_modules/.bin/briq /usr/local/bin/briq \
  && briq --version \
  && npm cache clean --force

# The terminal page: ttyd, one static binary.
RUN V="${TTYD_VERSION:-$(curl -fsSL https://api.github.com/repos/tsl0922/ttyd/releases/latest | jq -r .tag_name)}" \
  && R="https://github.com/tsl0922/ttyd/releases/download/${V}" \
  && curl -fsSL "$R/ttyd.x86_64" -o /usr/local/bin/ttyd \
  && H="$(curl -fsSL "$R/SHA256SUMS" | awk '$2 == "ttyd.x86_64" { print $1 }')" \
  && echo "$H  /usr/local/bin/ttyd" | sha256sum -c - \
  && printf 'ttyd\t%s\tits SHA256SUMS\n' "$H" >> /etc/t3-cloud/downloads \
  && chmod 755 /usr/local/bin/ttyd

# Shared native CLI tools; neither runtime owns the other runtime's state.
COPY bin/show-url /usr/local/bin/show-url
RUN chmod 755 /usr/local/bin/show-url && ln -s /usr/local/bin/show-url /usr/local/bin/xdg-open

# Compile the pinned MIT-licensed T3 source, including the native cloud RPC and
# creation gate. The lock and patch are verified before executing build tools.
FROM node:26.12.1-bookworm AS t3-source
WORKDIR /src
COPY t3-source /input
RUN node -e 'const f=require("fs"),c=require("crypto"),m=require("/input/source.json"); if(c.createHash("sha256").update(f.readFileSync("/input/briq-sandbox.patch")).digest("hex")!==m.patchSha256)process.exit(1)'
RUN git init . && git remote add origin https://github.com/pingdotgg/t3code.git \
  && git fetch --depth 1 origin 2359643cffa6ba9ee84d6f2694b935de54a8013e \
  && git checkout --detach FETCH_HEAD \
  && test "$(git rev-parse HEAD)" = 2359643cffa6ba9ee84d6f2694b935de54a8013e \
  && echo 'e799bbbc9cd012f14be1a75a6fcdec81956c4386306fdc3a9285191c67290c13  pnpm-lock.yaml' | sha256sum -c - \
  && git apply --check /input/briq-sandbox.patch && git apply /input/briq-sandbox.patch
RUN npm install --global pnpm@12.14.0 --ignore-scripts --no-fund --no-audit \
  && pnpm install --frozen-lockfile --filter t3... --filter @t3tools/web... --filter @t3tools/scripts... --filter @t3tools/monorepo \
  && pnpm exec vp run --filter t3 build \
  && pnpm --filter t3 deploy --prod --legacy --config.allow-unused-patches=true /out/t3 \
  && cp /usr/local/bin/node /out/t3/node \
  && cp /input/LICENSE /input/source.json /out/t3/ \
  && printf '#!/bin/sh\nexec /opt/t3/node /opt/t3/dist/bin.mjs "$@"\n' > /out/t3/t3 \
  && chmod 755 /out/t3/t3
# Keep the unmodified, checksum-verified native resource monitor sidecar.
RUN curl -fsSL https://github.com/pingdotgg/t3code/releases/download/v0.1.6/t3-0.1.6-linux-x64.tar.gz -o /tmp/t3.tar.gz \
  && echo '7cf31da90dee41f524dd5b679ebb6d404637ca5d9dc6fd8bc019511d57bb77e6  /tmp/t3.tar.gz' | sha256sum -c - \
  && mkdir /tmp/t3-release && tar --strip-components=1 -xzf /tmp/t3.tar.gz -C /tmp/t3-release \
  && cp -a /tmp/t3-release/resource-monitor /out/t3/

FROM native-clis AS t3-cloud
COPY --from=t3-source /out/t3 /opt/t3
# T3's SDK/tool protocol has its own compatibility pin.
RUN V="$(node -p 'require("/opt/t3/source.json").claude')" \
  && H="$(node -e 'const m=require("/opt/t3/source.json"),p=require("/opt/t3/node_modules/@anthropic-ai/claude-agent-sdk/package.json"),c=require("/opt/t3/node_modules/@anthropic-ai/claude-agent-sdk/manifest.json"),a=require("node:assert/strict");a.match(m.claude,/^\d+\.\d+\.\d+$/);a.equal(p.version,m.claudeSdk);a.equal(c.version,m.claude);const h=c.platforms["linux-x64"].checksum;a.match(h,/^[a-f0-9]{64}$/);process.stdout.write(h)')" \
  && if ! echo "$H  /usr/local/bin/claude" | sha256sum -c - > /dev/null 2>&1; then \
    curl -fsSL "https://downloads.claude.ai/claude-code-releases/$V/linux-x64/claude" -o /tmp/t3-claude \
    && echo "$H  /tmp/t3-claude" | sha256sum -c - \
    && install -m 755 /tmp/t3-claude /usr/local/bin/claude && rm /tmp/t3-claude; \
  fi \
  && test "$(claude --version)" = "$V (Claude Code)" \
  && printf 'Claude Code T3 compatibility\t%s\tSDK release manifest\n' "$H" >> /etc/t3-cloud/downloads \
  && printf '%s\n' '{"disableAllHooks":true,"disableAgentView":true,"disableRemoteControl":true,"env":{"DISABLE_AUTOUPDATER":"1","DISABLE_UPDATES":"1"}}' > /etc/claude-code/managed-settings.json
RUN test "$(cat /etc/t3-cloud/codex-version)" = "$(node -p 'require("/opt/t3/source.json").codex')" \
  && test -x /opt/t3/t3 \
  && printf 'T3 Code source\t2359643cffa6ba9ee84d6f2694b935de54a8013e\tpinned source, lock and local patch\n' >> /etc/t3-cloud/downloads

COPY . /opt/t3-cloud
# Use the same pinned Node for the manager, child and scoped transport shim.
# The runtime imports native TypeScript modules and requires bash for child execution.
RUN ln -sf /opt/t3/node /usr/local/bin/node \
  && test "$(node --version)" = "v$(node -p 'require("/opt/t3/source.json").node')" \
  && test -x /bin/bash \
  && cd /opt/t3-cloud \
  && npm ci --omit=dev --ignore-scripts --no-fund --no-audit \
  && npm cache clean --force
COPY bin/t3-cloud-start /usr/local/bin/t3-cloud-start
RUN chmod 755 /usr/local/bin/t3-cloud-start
EXPOSE 8080
CMD ["t3-cloud-start"]
