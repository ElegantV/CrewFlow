FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
# 国内 apk 源(官方 CDN 在大陆限速严重)。默认公网阿里云镜像;阿里云 ECS 上可在 .env 设
# APK_MIRROR=http://mirrors.cloud.aliyuncs.com 走内网(不计公网带宽,仅支持 http)。
ARG APK_MIRROR=https://mirrors.aliyun.com
ENV NODE_ENV=production
WORKDIR /app
RUN sed -i "s#https://dl-cdn.alpinelinux.org#${APK_MIRROR}#g" /etc/apk/repositories \
  && apk add --no-cache font-noto-cjk
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
