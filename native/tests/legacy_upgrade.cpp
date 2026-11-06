#include "coc/store.hpp"
#include <iostream>
using namespace coc;
int main(int argc, char **argv) {
  try {
    if (argc != 3)
      return 2;
    Store store(argv[2], false);
    if (std::string(argv[1]) == "seed") {
      store.save(
          {{"id", "legacy"},
           {"mode", "web"},
           {"state", "closed"},
           {"projectId", "original-project"},
           {"promptQueue",
            Json::array({{{"id", "queued"}, {"text", "original-message"}, {"state", "queued"}}})}});
      store.event("legacy", "user", {{"text", "original-history"}});
      store.cache_put("upgrade-proof", {{"receipt", "original-receipt"}});
    } else if (store.get("legacy").at("promptQueue").at(0).at("text") != "original-message" ||
               store.get("legacy").at("projectId") != "original-project" ||
               store.cache_get("upgrade-proof").at("receipt") != "original-receipt" ||
               store.replay("legacy", 0).dump().find("original-history") == std::string::npos) {
      return 3;
    }
    std::cout << "PASS: legacy session, queue, history and receipt preserved\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
