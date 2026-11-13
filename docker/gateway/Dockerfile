# PHYSIOS gateway + frontend in one small image (Python standard library only).
#
# Build context: the repository root. The frontend must already be built
# (`./scripts/install.sh` or `cd frontend && npm ci && npm run build`);
# `./docker/physios-docker.sh build` does it for you.
#
# The robot runtime runs in its own image (docker/robot/Dockerfile). The training service
# (backend/physios_trainer) runs on the host because it uses your LeRobot Python environment
# and GPU; ./start_physios.sh starts it.
ARG BASE_IMAGE=python:3.12-slim
FROM ${BASE_IMAGE}

ARG PHYSIOS_VERSION=2.0.0
ARG UID=1000
ARG GID=1000
LABEL org.opencontainers.image.title="PHYSIOS gateway" \
      org.opencontainers.image.description="The Operating System for Physical Intelligence: gateway and frontend" \
      org.opencontainers.image.source="https://github.com/Nanditha-G-02/physios" \
      org.opencontainers.image.version="${PHYSIOS_VERSION}" \
      org.opencontainers.image.licenses="Apache-2.0"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PHYSIOS_CONFIG=/nonexistent \
    PHYSIOS_HOST=127.0.0.1 \
    PHYSIOS_PORT=8700 \
    PHYSIOS_DATA_DIR=/physios/data \
    PHYSIOS_DATASET_ROOTS=/physios/data/huggingface/lerobot:/data/hf-lerobot \
    PHYSIOS_VAR_DIR=/var/lib/physios

WORKDIR /opt/physios
COPY VERSION VERSION
COPY backend/physios_gateway backend/physios_gateway
# host information (OS, GPU, disks) comes from the training service's environment module
COPY backend/physios_trainer backend/physios_trainer
COPY frontend/dist frontend/dist
COPY configuration/physios.env.example configuration/physios.env.example

RUN mkdir -p /var/lib/physios /physios/data /data/hf-lerobot \
 && chown -R ${UID}:${GID} /var/lib/physios \
 && python3 -c "import sys; sys.path.insert(0, 'backend'); import physios_gateway.app, physios_trainer.environment" \
 && test -f frontend/dist/index.html

USER ${UID}:${GID}
WORKDIR /opt/physios/backend
EXPOSE 8700
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD python3 -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/api/v1/auth/session' % os.environ.get('PHYSIOS_PORT','8700'), timeout=4)" || exit 1
ENTRYPOINT ["python3", "-m", "physios_gateway"]
