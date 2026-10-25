#include "coc/windows.hpp"
#include <iostream>
int main(int argc, char **argv) {
  if (argc > 1 && std::string(argv[1]) == "--version") {
    std::cout << "codex-cli 0.164.0\n";
    return 0;
  }
  if (argc > 1 && std::string(argv[1]) == "--echo-args") {
    coc::Json args = coc::Json::array();
    for (int i = 2; i < argc; ++i)
      args.push_back(argv[i]);
    std::cout << args.dump() << '\n';
    return 0;
  }
  if (argc > 1 && std::string(argv[1]) == "--sleep") {
    Sleep(INFINITE);
    return 0;
  }
  if (argc > 1 && std::string(argv[1]) == "--spawn-child") {
    wchar_t path[32768];
    auto length = GetModuleFileNameW(nullptr, path, 32768);
    if (!length || length >= 32768)
      return 1;
    auto command = coc::quote_windows_argument(std::wstring(path, length)) + L" --sleep";
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(path, command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr,
                        nullptr, &startup, &process))
      return 1;
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    std::cout << process.dwProcessId << std::endl;
    Sleep(INFINITE);
    return 0;
  }
  std::string line;
  while (std::getline(std::cin, line)) {
    auto value = coc::Json::parse(line);
    if (value.contains("id"))
      std::cout << coc::Json{{"id", value["id"]}, {"result", {{"ok", true}}}}.dump() << std::endl;
  }
}
