# Real n8n with the Darkmoon community node baked in (test lab).
# The node is installed exactly as a community package would be: into
# ~/.n8n/nodes/node_modules, from the packed tarball.
FROM n8nio/n8n:latest

USER root

ARG PKG=n8n-nodes-darkmoon-0.3.0.tgz
COPY ${PKG} /tmp/${PKG}

RUN mkdir -p /home/node/.n8n/nodes \
	&& cd /home/node/.n8n/nodes \
	&& npm init -y >/dev/null 2>&1 \
	&& npm install /tmp/${PKG} --omit=dev --omit=peer --omit=optional --ignore-scripts --no-audit --no-fund \
	&& chown -R node:node /home/node/.n8n

USER node
