# PHYSIOS robot runtime: ROS 2 Jazzy with the robot server (robot/src/physical_ai_server,
# including the PHYSIOS planning engine), its interfaces, the bag recorder, rosbridge and
# web_video_server, plus LeRobot for recording and on-robot inference.
#
# Build context: the repository root (./docker/physios-docker.sh build robot).
# Everything is built from this repository; only public base images and packages are
# downloaded (ROS/torch base image, apt and pip packages, LeRobot from its upstream git).
#
# BASE_IMAGE must provide ROS 2 Jazzy and PyTorch. The default is the same public ROS 2 +
# PyTorch 2.7 + CUDA 12.8 image that the 1.x robot container was built on. To start from the
# official ROS image instead, build with
#   --build-arg BASE_IMAGE=ros:jazzy-ros-base --build-arg INSTALL_TORCH=1
ARG BASE_IMAGE=robotis/ros:jazzy-ros-base-torch2.7.0-cuda12.8.0-v3
FROM ${BASE_IMAGE}

ARG PHYSIOS_VERSION=2.0.0
ARG INSTALL_TORCH=0
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cu128
ARG TORCH_PACKAGES="torch==2.7.0 torchvision==0.22.0"
# keep in step with robot/lerobot.lock
ARG LEROBOT_REPOSITORY=https://github.com/huggingface/lerobot.git
ARG LEROBOT_COMMIT=989f3d05ba47f872d75c587e76838e9cc574857a

LABEL org.opencontainers.image.title="PHYSIOS robot runtime" \
      org.opencontainers.image.source="https://github.com/Nanditha-G-02/physios" \
      org.opencontainers.image.version="${PHYSIOS_VERSION}" \
      org.opencontainers.image.licenses="Apache-2.0"

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PIP_NO_CACHE_DIR=1 \
    COLCON_WS=/root/ros2_ws \
    PHYSIOS_CONTAINER_DATA=/physios/data \
    PHYSICAL_AI_MANAGER_DATA=/workspace/physios \
    RMW_IMPLEMENTATION=rmw_zenoh_cpp \
    ROS_DOMAIN_ID=30

RUN apt-get update && apt-get install -y --no-install-recommends \
      git xz-utils ffmpeg python3-pip ros-${ROS_DISTRO}-rmw-zenoh-cpp \
 && rm -rf /var/lib/apt/lists/*

RUN if [ "${INSTALL_TORCH}" = "1" ]; then \
      pip install --ignore-installed ${TORCH_PACKAGES} --index-url "${TORCH_INDEX_URL}"; \
    fi

# LeRobot at the pinned commit; torch/torchvision come from the base image (as in 1.x)
RUN git init -q /opt/lerobot && cd /opt/lerobot \
 && git remote add origin "${LEROBOT_REPOSITORY}" \
 && git fetch -q --depth 1 origin "${LEROBOT_COMMIT}" && git checkout -q FETCH_HEAD \
 && sed -i '/"torch[^\"]*",/d; /"torchvision[^\"]*",/d' pyproject.toml \
 && pip install --ignore-installed -e . \
 && pip install -e ".[smolvla]" \
 && pip install pyzmq psutil matplotlib requests \
 && pip install setuptools==68.1.2 'numpy<2'

# the PHYSIOS robot packages
COPY robot/src ${COLCON_WS}/src/physios
RUN source /opt/ros/${ROS_DISTRO}/setup.bash && cd ${COLCON_WS} \
 && apt-get update && (rosdep update || true) \
 && rosdep install -i --from-path src --rosdistro ${ROS_DISTRO} -y \
 && rm -rf /var/lib/apt/lists/* \
 && colcon build --cmake-args -DCMAKE_BUILD_TYPE=Release \
 && rm -rf build log

COPY docker/robot/entrypoint.sh /usr/local/bin/physios-robot
RUN chmod +x /usr/local/bin/physios-robot \
 && mkdir -p /physios/data /workspace /root/.cache/huggingface \
 && echo "source /opt/ros/${ROS_DISTRO}/setup.bash" >> /root/.bashrc \
 && echo "source ${COLCON_WS}/install/setup.bash" >> /root/.bashrc

WORKDIR /physios/data
ENTRYPOINT ["/usr/local/bin/physios-robot"]
CMD ["run"]
