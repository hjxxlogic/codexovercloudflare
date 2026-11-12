type TabLabelInput = { title: string; directory?: string; project?: string };

// Titles are case insensitive; paths retain the host filesystem's spelling.
export function sessionTabLabels(tabs: TabLabelInput[]) {
  const counts = new Map<string, number>();
  const directories = new Map<string, number>();
  for (const tab of tabs) {
    const title = tab.title.toLowerCase();
    const scope = JSON.stringify([title, tab.directory || '']);
    counts.set(title, (counts.get(title) || 0) + 1);
    directories.set(scope, (directories.get(scope) || 0) + 1);
  }
  return tabs.map((tab) => {
    const title = tab.title.toLowerCase();
    const scope = JSON.stringify([title, tab.directory || '']);
    const context =
      (counts.get(title) || 0) > 1
        ? [
            tab.directory,
            (directories.get(scope) || 0) > 1 ? tab.project : undefined,
          ]
            .filter(Boolean)
            .join(' · ')
        : '';
    return {
      title: tab.title,
      context,
      label: [tab.title, context].filter(Boolean).join(' · '),
    };
  });
}
