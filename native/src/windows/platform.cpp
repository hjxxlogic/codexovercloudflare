#include "coc/windows.hpp"
#include <aclapi.h>
#include <algorithm>
#include <cstdlib>
#include <iostream>
#include <sddl.h>
#include <winternl.h>
namespace coc {
std::wstring wide(const std::string &text) {
  if (text.empty())
    return {};
  int n =
      MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), int(text.size()), nullptr, 0);
  if (!n)
    throw Error("INVALID_INPUT", "Expected UTF-8 text");
  std::wstring result(n, L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), int(text.size()), result.data(),
                      n);
  return result;
}
std::string utf8(const std::wstring &text) {
  if (text.empty())
    return {};
  int n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), int(text.size()), nullptr,
                              0, nullptr, nullptr);
  if (!n)
    throw Error("INVALID_INPUT", "Invalid Unicode text");
  std::string result(n, '\0');
  WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), int(text.size()), result.data(),
                      n, nullptr, nullptr);
  return result;
}
namespace {
struct Security {
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), nullptr, FALSE};
  Security() {
    HANDLE raw = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw))
      throw Error("CONFIG_ERROR", "Cannot inspect Windows user");
    WinHandle token(raw);
    DWORD size = 0;
    GetTokenInformation(raw, TokenUser, nullptr, 0, &size);
    std::vector<unsigned char> buffer(size);
    if (!GetTokenInformation(raw, TokenUser, buffer.data(), size, &size))
      throw Error("CONFIG_ERROR", "Cannot inspect Windows user");
    LPWSTR sid = nullptr;
    if (!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER *>(buffer.data())->User.Sid, &sid))
      throw Error("CONFIG_ERROR", "Cannot inspect Windows SID");
    std::wstring sddl = L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + std::wstring(sid) + L")";
    LocalFree(sid);
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1,
                                                              &descriptor, nullptr))
      throw Error("CONFIG_ERROR", "Cannot create private Windows ACL");
    attributes.lpSecurityDescriptor = descriptor;
  }
  ~Security() {
    if (descriptor)
      LocalFree(descriptor);
  }
};
} // namespace
namespace {
void protect_handle(HANDLE handle, Security &security) {
  PACL acl = nullptr;
  BOOL present = FALSE, defaults = FALSE;
  if (!GetSecurityDescriptorDacl(security.descriptor, &present, &acl, &defaults) || !present ||
      SetSecurityInfo(handle, SE_FILE_OBJECT,
                      DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, nullptr,
                      nullptr, acl, nullptr) != ERROR_SUCCESS)
    throw Error("CONFIG_ERROR", "Cannot protect private Windows path");
}
} // namespace
void private_path(const std::filesystem::path &path) {
  Security security;
  WinHandle handle(CreateFileW(path.c_str(), READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES,
                               FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                               OPEN_EXISTING,
                               FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  BY_HANDLE_FILE_INFORMATION info{};
  if (!handle || !GetFileInformationByHandle(handle.get(), &info) ||
      (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT))
    throw Error("CONFIG_ERROR", "Private Windows paths cannot be symbolic links or junctions");
  protect_handle(handle.get(), security);
}
HANDLE private_file(const std::filesystem::path &path, DWORD access, DWORD sharing,
                    DWORD creation) {
  Security security;
  WinHandle handle(CreateFileW(path.c_str(), access | READ_CONTROL | WRITE_DAC, sharing,
                               &security.attributes, creation,
                               FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (handle) {
    BY_HANDLE_FILE_INFORMATION info{};
    if (!GetFileInformationByHandle(handle.get(), &info) ||
        (info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)))
      return INVALID_HANDLE_VALUE;
    protect_handle(handle.get(), security);
  }
  return handle.release();
}

HANDLE relative_file(HANDLE parent, const std::wstring &name, DWORD access, DWORD sharing,
                     DWORD creation, bool folder, bool private_acl) {
  if (name.empty() || name == L"." || name == L".." || name.size() > 32767 ||
      name.find_first_of(L"\\/:") != std::wstring::npos || name.find(L'\0') != std::wstring::npos)
    throw Error("INVALID_PATH", "Expected a single relative Windows filename");
  using Create = NTSTATUS(NTAPI *)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK,
                                   PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
  using ToError = ULONG(NTAPI *)(NTSTATUS);
  auto module = GetModuleHandleW(L"ntdll.dll");
  static auto create = reinterpret_cast<Create>(GetProcAddress(module, "NtCreateFile"));
  static auto to_error = reinterpret_cast<ToError>(GetProcAddress(module, "RtlNtStatusToDosError"));
  if (!create || !to_error)
    throw Error("FILE_IO", "Windows relative file access is unavailable");
  ULONG disposition = 0;
  if (creation == OPEN_EXISTING)
    disposition = 1; // FILE_OPEN
  else if (creation == CREATE_NEW)
    disposition = 2; // FILE_CREATE
  else
    throw Error("FILE_IO", "Unsupported relative file disposition");
  std::unique_ptr<Security> security;
  if (private_acl)
    security = std::make_unique<Security>();
  UNICODE_STRING text{};
  text.Buffer = const_cast<wchar_t *>(name.c_str());
  text.Length = text.MaximumLength = static_cast<USHORT>(name.size() * sizeof(wchar_t));
  OBJECT_ATTRIBUTES attributes{};
  attributes.Length = sizeof(attributes);
  attributes.RootDirectory = parent;
  attributes.ObjectName = &text;
  attributes.Attributes = 0x40 | 0x1000; // OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE
  attributes.SecurityDescriptor = security ? security->descriptor : nullptr;
  IO_STATUS_BLOCK result{};
  HANDLE raw = INVALID_HANDLE_VALUE;
  // FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT and the expected type.
  const ULONG options = 0x00200000 | 0x20 | (folder ? 0x1 : 0x40);
  const auto status =
      create(&raw, access | SYNCHRONIZE | (private_acl ? READ_CONTROL | WRITE_DAC : 0), &attributes,
             &result, nullptr, FILE_ATTRIBUTE_NORMAL, sharing, disposition, options, nullptr, 0);
  if (status < 0) {
    auto error = to_error(status);
    security.reset();
    SetLastError(error);
    return INVALID_HANDLE_VALUE;
  }
  WinHandle handle(raw);
  if (security)
    protect_handle(handle.get(), *security);
  return handle.release();
}
std::wstring quote_windows_argument(const std::wstring &value) {
  std::wstring result = L"\"";
  size_t slashes = 0;
  for (wchar_t c : value) {
    if (c == L'\\') {
      ++slashes;
      continue;
    }
    result.append(slashes * (c == L'"' ? 2 : 1), L'\\');
    slashes = 0;
    if (c == L'"')
      result += L'\\';
    result += c;
  }
  result.append(slashes * 2, L'\\');
  return result + L'"';
}
std::string codex_executable() {
  if (auto path = _wgetenv(L"COC_CODEX_PATH"))
    return utf8(path);
  wchar_t path[32768];
  auto search = _wgetenv(L"PATH");
  auto count = search ? SearchPathW(search, L"codex.exe", nullptr, 32768, path, nullptr) : 0;
  if (count && count < 32768)
    return utf8(std::wstring(path, count));
  throw Error(
      "SPAWN_FAILED",
      "Put the native codex.exe on PATH or set COC_CODEX_PATH; .cmd launchers are unsupported");
}
namespace {
void pipe_pair(WinHandle &parent, WinHandle &child, bool parent_reads) {
  auto name = L"\\\\.\\pipe\\coc-" + wide(uuid());
  parent.reset(CreateNamedPipeW(name.c_str(),
                                (parent_reads ? PIPE_ACCESS_INBOUND : PIPE_ACCESS_OUTBOUND) |
                                    FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
                                PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 65536,
                                65536, 0, nullptr));
  if (!parent)
    throw Error("SPAWN_FAILED", "Cannot create Codex pipe");
  SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
  child.reset(CreateFileW(name.c_str(), parent_reads ? GENERIC_WRITE : GENERIC_READ, 0, &security,
                          OPEN_EXISTING, 0, nullptr));
  if (!child)
    throw Error("SPAWN_FAILED", "Cannot connect Codex pipe");
}
} // namespace
WindowsChild::WindowsChild(const std::vector<std::string> &args, const std::string &cwd,
                           bool redirected, const std::string &ticket, const Json &overrides) {
  if (args.empty())
    throw Error("SPAWN_FAILED", "Empty process arguments");
  auto executable = args[0] == "codex" ? wide(codex_executable()) : wide(args[0]);
  if (_wcsicmp(std::filesystem::path(executable).extension().c_str(), L".exe") != 0)
    throw Error("SPAWN_FAILED", "Windows requires a native .exe, not a shell launcher");
  std::wstring command = quote_windows_argument(executable);
  for (size_t i = 1; i < args.size(); ++i)
    command += L" " + quote_windows_argument(wide(args[i]));
  std::vector<wchar_t> environment;
  if (!ticket.empty() || !overrides.empty()) {
    auto raw = GetEnvironmentStringsW();
    if (!raw)
      throw Error("SPAWN_FAILED", "Cannot copy process environment");
    std::vector<std::wstring> entries;
    std::vector<std::wstring> removed;
    for (auto it = overrides.begin(); it != overrides.end(); ++it)
      removed.push_back(wide(it.key()) + L"=");
    if (!ticket.empty())
      removed.push_back(L"COC_REMOTE_TICKET=");
    for (auto entry = raw; *entry; entry += wcslen(entry) + 1) {
      if (std::none_of(removed.begin(), removed.end(), [&](const auto &key) {
            return _wcsnicmp(entry, key.c_str(), key.size()) == 0;
          }))
        entries.emplace_back(entry);
    }
    FreeEnvironmentStringsW(raw);
    for (auto it = overrides.begin(); it != overrides.end(); ++it) {
      if (it.value().is_null())
        continue;
      const auto key = wide(it.key()) + L"=";
      if (!ticket.empty() && _wcsicmp(key.c_str(), L"COC_REMOTE_TICKET=") == 0)
        continue;
      entries.erase(std::remove_if(entries.begin(), entries.end(),
                                   [&](const auto &entry) {
                                     return _wcsnicmp(entry.c_str(), key.c_str(), key.size()) == 0;
                                   }),
                    entries.end());
      entries.push_back(key + wide(it.value().get<std::string>()));
    }
    if (!ticket.empty())
      entries.push_back(L"COC_REMOTE_TICKET=" + wide(ticket));
    std::sort(entries.begin(), entries.end(),
              [](const auto &a, const auto &b) { return _wcsicmp(a.c_str(), b.c_str()) < 0; });
    for (auto &entry : entries) {
      environment.insert(environment.end(), entry.begin(), entry.end());
      environment.push_back(0);
    }
    environment.push_back(0);
    if (entries.empty())
      environment.push_back(0);
  }
  WinHandle child_in, child_out, child_err;
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  std::vector<unsigned char> attribute_storage;
  HANDLE inherited[3]{};
  if (redirected) {
    pipe_pair(input, child_in, false);
    pipe_pair(output, child_out, true);
    SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
    child_err.reset(CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                &security, OPEN_EXISTING, 0, nullptr));
    if (!child_err)
      throw Error("SPAWN_FAILED", "Cannot redirect Codex stderr");
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = inherited[0] = child_in.get();
    startup.StartupInfo.hStdOutput = inherited[1] = child_out.get();
    startup.StartupInfo.hStdError = inherited[2] = child_err.get();
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
    attribute_storage.resize(size);
    startup.lpAttributeList =
        reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attribute_storage.data());
    if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &size))
      throw Error("SPAWN_FAILED", "Cannot initialize handle inheritance");
    if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                   inherited, sizeof(inherited), nullptr, nullptr)) {
      DeleteProcThreadAttributeList(startup.lpAttributeList);
      throw Error("SPAWN_FAILED", "Cannot restrict handle inheritance");
    }
  } else
    startup.StartupInfo.cb = sizeof(STARTUPINFOW);
  job_.reset(CreateJobObjectW(nullptr, nullptr));
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!job_ || !SetInformationJobObject(job_.get(), JobObjectExtendedLimitInformation, &limits,
                                        sizeof(limits))) {
    if (startup.lpAttributeList)
      DeleteProcThreadAttributeList(startup.lpAttributeList);
    throw Error("SPAWN_FAILED", "Cannot create Codex process job");
  }
  PROCESS_INFORMATION process{};
  auto directory = wide(cwd);
  DWORD flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT;
  if (redirected)
    flags |= EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW;
  BOOL created =
      CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, redirected, flags,
                     environment.empty() ? nullptr : environment.data(),
                     cwd.empty() ? nullptr : directory.c_str(), &startup.StartupInfo, &process);
  if (startup.lpAttributeList)
    DeleteProcThreadAttributeList(startup.lpAttributeList);
  if (!created)
    throw Error("SPAWN_FAILED", "Cannot start native Codex executable");
  process_.reset(process.hProcess);
  WinHandle thread(process.hThread);
  if (!AssignProcessToJobObject(job_.get(), process_.get()) ||
      ResumeThread(thread.get()) == DWORD(-1)) {
    TerminateProcess(process_.get(), 1);
    throw Error("SPAWN_FAILED", "Cannot contain Codex process tree");
  }
}
bool WindowsChild::poll(DWORD &code) const {
  auto result = WaitForSingleObject(process_.get(), 0);
  if (result == WAIT_TIMEOUT)
    return false;
  if (result != WAIT_OBJECT_0 || !GetExitCodeProcess(process_.get(), &code))
    throw Error("SPAWN_FAILED", "Cannot inspect Codex process");
  return true;
}
void WindowsChild::terminate() { TerminateJobObject(job_.get(), 1); }
std::string windows_capture(const std::vector<std::string> &args, size_t limit,
                            const Json &environment) {
  WindowsChild child(args, "", true, "", environment);
  child.input.reset();
  boost::asio::io_context io;
  boost::asio::windows::stream_handle output(io, child.output.release());
  boost::asio::steady_timer timer(io, std::chrono::seconds(10));
  std::string bytes;
  bool timeout = false, overflow = false;
  char buffer[4096];
  std::function<void()> read = [&] {
    output.async_read_some(boost::asio::buffer(buffer), [&](auto ec, size_t n) {
      if (bytes.size() + n > limit) {
        overflow = true;
        child.terminate();
        output.close();
        timer.cancel();
        return;
      }
      bytes.append(buffer, n);
      if (!ec)
        read();
      else
        timer.cancel();
    });
  };
  timer.async_wait([&](auto ec) {
    if (!ec) {
      timeout = true;
      child.terminate();
      output.close();
    }
  });
  read();
  io.run();
  DWORD code = 1;
  const auto deadline = now() + 1000;
  while (!child.poll(code) && now() < deadline)
    Sleep(5);
  if (timeout || overflow || !child.poll(code) || code != 0)
    throw Error("SPAWN_FAILED", "Codex subprocess failed, timed out or exceeded output limit");
  return bytes;
}
void windows_console() {
  SetConsoleCP(CP_UTF8);
  SetConsoleOutputCP(CP_UTF8);
  for (auto stream : {STD_OUTPUT_HANDLE, STD_ERROR_HANDLE}) {
    DWORD mode;
    auto handle = GetStdHandle(stream);
    if (GetConsoleMode(handle, &mode))
      SetConsoleMode(handle, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
  }
}
} // namespace coc
