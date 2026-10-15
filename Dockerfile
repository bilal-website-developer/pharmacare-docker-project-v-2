FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY scripts/setup-hooks.mjs ./scripts/setup-hooks.mjs
RUN npm ci

ARG VITE_SUPABASE_URL=""
ARG VITE_SUPABASE_ANON_KEY=""
ARG VITE_BACKEND="api"
ARG VITE_SHOP_SLUG="main"
ENV VITE_SUPABASE_URL=${VITE_SUPABASE_URL}
ENV VITE_SUPABASE_ANON_KEY=${VITE_SUPABASE_ANON_KEY}
ENV VITE_BACKEND=${VITE_BACKEND}
ENV VITE_SHOP_SLUG=${VITE_SHOP_SLUG}

COPY . .
RUN npm run build:web

FROM nginx:1.27.5-alpine AS runtime
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
