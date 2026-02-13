const path = require("path");
const root = path.resolve(__dirname, "..");

module.exports = {
  apps: [
    {
      name: "grog-api",
      script: "api/dist/index.js",
      cwd: root,
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        LOG_FORMAT: "json",
        LOG_LEVEL: "info",
        API_PORT: 3001,
      },
      error_file: "logs/api-error.log",
      out_file: "logs/api-out.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
    {
      name: "grog-agent",
      script: "agent/dist/index.js",
      cwd: root,
      instances: 2,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        LOG_FORMAT: "json",
        LOG_LEVEL: "info",
        MAX_CONCURRENT_JOBS: 2,
        AGENT_TIMEOUT_MINUTES: 30,
        MAX_RETRIES: 2,
      },
      error_file: "logs/agent-error.log",
      out_file: "logs/agent-out.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
  ],
};
