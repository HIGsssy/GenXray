module.exports = {
  apps: [
    {
      name: "comfygen",
      script: "dist/index.js",
      interpreter: "node",
      cwd: "/opt/comfygen",
      env_production: {
        NODE_ENV: "production",
      },
      // Secrets come from .env file loaded by config.ts or shell environment
      restart_delay: 5000,
      max_restarts: 10,
      watch: false,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
