# PHYSIOS gateway + frontend in one small image (Python standard library only).
#
# Build context: the physios/ folder. The frontend must already be built (frontend/dist ships
# in physios.zip; otherwise run `cd frontend && npm ci && npm run build` or
# `./docker/physios-docker.sh build`, which does it for you).
#
# The robot side (physical_ai_server, rosbridge, web_video_server) and the training service
# (pam_trainer, which needs your LeRobot conda environment and GPU) keep running where they
# run today. This container only replaces `./start_physios.sh`'s gateway process.
ARG BASE_IMAGE=python:3.12-slim
FROM ${BASE_IMAGE}

ARG PHYSIOS_VERSION=1.2.0
ARG UID=1000
ARG GID=1000
LABEL org.opencontainers.image.title="PHYSIOS" \
      org.opencontainers.image.description="The Operating System for Physical Intelligence: gateway and frontend" \
      org.opencontainers.image.version="${PHYSIOS_VERSION}" \
      org.opencontainers.image.licenses="Apache-2.0"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PHYSIOS_CONFIG=/nonexistent \
    PHYSIOS_HOST=127.0.0.1 \
    PHYSIOS_PORT=8700 \
    PHYSIOS_REPO_ROOT=/repo \
    PHYSIOS_DATASET_ROOTS=/repo/docker/huggingface/lerobot:/data/hf-lerobot \
    PHYSIOS_VAR_DIR=/var/lib/physios

WORKDIR /opt/physios
COPY backend/physios_gateway backend/physios_gateway
COPY frontend/dist frontend/dist
COPY configuration/physios.env.example configuration/physios.env.example

RUN mkdir -p /var/lib/physios /repo /data/hf-lerobot \
 && chown -R ${UID}:${GID} /var/lib/physios \
 && python3 -c "import sys; sys.path.insert(0, 'backend'); import physios_gateway.app" \
 && test -f frontend/dist/index.html

USER ${UID}:${GID}
WORKDIR /opt/physios/backend
EXPOSE 8700
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD python3 -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/api/v1/auth/session' % os.environ.get('PHYSIOS_PORT','8700'), timeout=4)" || exit 1
ENTRYPOINT ["python3", "-m", "physios_gateway"]
