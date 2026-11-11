export function createCommandContext(cwd) {
  const notifications = [];
  return {
    notifications,
    ctx: {
      cwd,
      ui: {
        notify(message, type = "info") {
          notifications.push({ message, type });
        },
      },
    },
  };
}
