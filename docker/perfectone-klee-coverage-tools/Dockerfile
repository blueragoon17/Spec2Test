FROM klee/klee:v3.2

USER root
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update -qq \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl gnupg lsb-release software-properties-common \
       git perl python3 sed grep coreutils gcc \
       libcapture-tiny-perl libdatetime-perl libtimedate-perl libjson-perl \
    && codename="$(lsb_release -cs)" \
    && curl -fsSL https://apt.llvm.org/llvm-snapshot.gpg.key | gpg --dearmor -o /etc/apt/trusted.gpg.d/apt.llvm.org.gpg \
    && printf 'deb http://apt.llvm.org/%s/ llvm-toolchain-%s-18 main\n' "$codename" "$codename" > /etc/apt/sources.list.d/llvm18.list \
    && apt-get update -qq \
    && apt-get install -y --no-install-recommends clang-18 llvm-18 llvm-18-tools libclang-rt-18-dev \
    && git clone --depth 1 https://github.com/linux-test-project/lcov.git /opt/perfectone/lcov_latest \
    && chmod +x /opt/perfectone/lcov_latest/bin/* \
    && printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'export PERL5LIB=/opt/perfectone/lcov_latest/lib:${PERL5LIB:-}' 'exec /opt/perfectone/lcov_latest/bin/lcov "$@"' > /usr/local/bin/lcov \
    && printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'export PERL5LIB=/opt/perfectone/lcov_latest/lib:${PERL5LIB:-}' 'exec /opt/perfectone/lcov_latest/bin/genhtml "$@"' > /usr/local/bin/genhtml \
    && printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'export PERL5LIB=/opt/perfectone/lcov_latest/lib:${PERL5LIB:-}' 'exec /opt/perfectone/lcov_latest/bin/llvm2lcov "$@"' > /usr/local/bin/llvm2lcov \
    && chmod +x /usr/local/bin/lcov /usr/local/bin/genhtml /usr/local/bin/llvm2lcov \
    && rm -rf /var/lib/apt/lists/*

RUN clang-18 --version && llvm-cov-18 --version && llvm-profdata-18 --version && llvm2lcov --help >/dev/null
