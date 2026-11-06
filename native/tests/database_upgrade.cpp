#include "coc/store.hpp"
#include <iostream>

int main(int argc, char **argv) {
  if (argc != 2)
    return 2;
  try {
    // Opening only Store never starts subprocesses, connects a relay, or runs recovery tasks.
    coc::Store store(argv[1], false);
    std::cout << "Opened copied journal; sessions=" << store.sessions().size() << '\n';
    return 0;
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
