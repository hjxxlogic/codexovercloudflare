#pragma once
#include "common.hpp"
#include <utility>
namespace coc {
// Configure before starting network threads; only exact trusted origins receive credentials.
std::string configure_access(const std::string &file);
std::pair<std::string, std::string> access_credentials(const Url &url);
bool access_enabled(const Url &url);
} // namespace coc
