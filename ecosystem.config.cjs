module.exports = {
  apps: [
    {
      name: "temp-mail-server",
      script: "./src/server.ts",
      interpreter: "npx",
      interpreter_args: "tsx",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
