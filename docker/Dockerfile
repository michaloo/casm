# The image behind `casm container create`. One layer of agent CLIs plus casm
# itself on top of an official base, so a container can be managed exactly like
# any other casm host.
#
# BASE must be debian/ubuntu-based (apt + glibc): node:*, python:*, golang:*, …
# Anything without node still needs node for casm, which the base provides for
# node:* images and which EXTRA_SETUP must provide otherwise.
#
# No credentials at build time, ever - they would persist in image layers.
# casm seeds auth into a running container instead.
ARG BASE=node:22-bookworm-slim
FROM ${BASE}

# FROM consumes the first ARG BASE, so redeclare it to use the value in a LABEL
ARG BASE
ARG CLAUDE_PKG=@anthropic-ai/claude-code
ARG OPENCODE_PKG=opencode-ai
ARG PI_PKG=@earendil-works/pi-coding-agent
ARG CODEX_PKG=@openai/codex
ARG CASM_PKG=casm-cli
ARG EXTRA_PACKAGES=""
ARG EXTRA_SETUP=""

# git and openssh-client so the agent can actually use a repo; rsync and sqlite3
# because casm needs them (sqlite3 for opencode session listing); procps for the
# `ps` that `casm active` parses; bubblewrap because codex warns on every start
# without it and falls back to a bundled copy; sudo so the agent can install its own
# dependencies, which casm grants passwordless at create time. Root inside a
# container does not cross the container boundary, and an agent that cannot
# apt-get install is hobbled for unattended work.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git openssh-client rsync sqlite3 procps less sudo bubblewrap ${EXTRA_PACKAGES} \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g --no-fund --no-audit \
      "${CLAUDE_PKG}" "${OPENCODE_PKG}" "${PI_PKG}" "${CODEX_PKG}" "${CASM_PKG}" \
    && npm cache clean --force

RUN if [ -n "${EXTRA_SETUP}" ]; then sh -c "${EXTRA_SETUP}"; fi

# The container runs as the host's uid so files it writes into the mounted
# project belong to you, and because claude refuses to disable permissions while
# running as root. That uid is not known at build time, so HOME has to be
# writable by whoever turns up.
#
# casm overrides both of these at run time, pointing HOME at the host's own home
# path so that `~` means the same thing inside and out. /casmhome is only the
# fallback for running this image directly.
RUN mkdir -p /casmhome && chmod 1777 /casmhome
ENV HOME=/casmhome

# Recorded so `docker image inspect` reports what a container actually contains.
LABEL casm.agents="${CLAUDE_PKG} ${OPENCODE_PKG} ${PI_PKG} ${CODEX_PKG}"
LABEL casm.base="${BASE}"

WORKDIR /casmhome
CMD ["sleep", "infinity"]
