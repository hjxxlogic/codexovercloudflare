let identity: Promise<string> | undefined;
// A duplicated tab may inherit sessionStorage. A page-lifetime Web Lock makes
// it acquire a different stream instead of writing another tab's outbox.
export function deliveryIdentity(): Promise<string> {
  if (!identity)
    identity = (async () => {
      let id =
        sessionStorage.getItem('coc-delivery-tab') || crypto.randomUUID();
      if (navigator.locks) {
        for (;;) {
          const acquired = await new Promise<boolean>((resolve, reject) => {
            void navigator.locks
              .request(
                'coc-delivery-tab:' + id,
                { ifAvailable: true },
                async (lock) => {
                  resolve(!!lock);
                  if (lock) await new Promise<void>(() => {});
                },
              )
              .catch(reject);
          });
          if (acquired) break;
          id = crypto.randomUUID();
        }
      }
      sessionStorage.setItem('coc-delivery-tab', id);
      return id;
    })();
  return identity;
}
