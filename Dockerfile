FROM node:20-alpine

WORKDIR /app

COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.1.0 /lambda-adapter /opt/extensions/lambda-adapter

COPY backend/package*.json ./
RUN npm ci --omit=dev

COPY backend/src ./src

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
