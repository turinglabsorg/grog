module.exports = {
  apps: [
    {
      name: "grog-agent",
      script: "dist/index.js",
      cwd: __dirname,
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
        PORT: 3000,
        MAX_CONCURRENT_JOBS: 2,
        AGENT_TIMEOUT_MINUTES: 30,
        MAX_RETRIES: 2,
      },
      // Log files — PM2 handles rotation via pm2-logrotate module
      error_file: "logs/error.log",
      out_file: "logs/out.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
  ],
};
