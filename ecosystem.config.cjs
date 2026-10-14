module.exports = {
  apps: [
    {
      name: "buhome-app",
      // `next start` loads .env.production from the project folder.
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3000 -H 127.0.0.1",
      // One instance: OTP codes and rate limits are kept in process memory, so
      // several cluster workers would each see only part of them (a code sent
      // by one worker could not be verified by another). Scale up only after
      // moving that state to a shared store such as Redis.
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      kill_timeout: 10000,
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        // Behind nginx (deploy/nginx-buhome.conf), which sets X-Real-IP.
        TRUST_PROXY: "1",
        // Admin account, session key and audit log. Back this folder up.
        DATA_DIR: "/var/lib/buhome",
      },
    },
  ],
};
