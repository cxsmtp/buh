module.exports = {
  apps: [
    {
      name: "buhome-app",
      // If deploying standalone build:
      // script: "./.next/standalone/server.js",
      // If deploying standard Next.js:
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3000",
      instances: "max", // Utilize all available CPU cores on Hostinger VPS
      exec_mode: "cluster",
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
      },
    },
  ],
};
