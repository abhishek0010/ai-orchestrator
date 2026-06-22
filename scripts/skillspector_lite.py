#!/usr/bin/env python3
"""Lightweight SkillSpector-compatible scanner for SKILL.md files.

Implements static pattern checks from NVIDIA/SkillSpector without requiring
Python 3.12 or any external dependencies. Works with Python 3.9+.

Usage:
    python3 scripts/skillspector_lite.py [path]
    path: file or directory to scan (default: ./skills/)
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

# ---------------------------------------------------------------------------
# Patterns extracted from NVIDIA/SkillSpector (Apache-2.0)
# github.com/NVIDIA/SkillSpector
# ---------------------------------------------------------------------------

RULES: list[tuple[str, str, str, list[tuple[str, float]], int]] = [
    # (rule_id, severity, description, [(pattern, confidence), ...], re_flags)

    # P1: Instruction Override
    ("P1", "HIGH", "Instruction Override", [
        (r"ignore\s+(?:all\s+)?previous\s+instructions?", 0.8),
        (r"ignore\s+(?:all\s+)?(?:safety|security)\s+(?:rules?|constraints?|guidelines?)", 0.9),
        (r"override\s+(?:safety|security|system)", 0.9),
        (r"bypass\s+(?:safety|security|restrictions?|constraints?)", 0.9),
        (r"disregard\s+(?:all\s+)?(?:previous|safety|security)", 0.8),
        (r"forget\s+(?:all\s+)?(?:previous|your)\s+instructions?", 0.8),
        (r"you\s+are\s+now\s+(?:in\s+)?(?:jailbreak|unrestricted|unfiltered)\s+mode", 0.95),
        (r"enable\s+(?:developer|debug|admin|root)\s+mode", 0.7),
        (r"do\s+not\s+follow\s+(?:any|your|the)\s+(?:rules?|guidelines?)", 0.9),
        (r"you\s+must\s+(?:always\s+)?ignore", 0.7),
    ], re.IGNORECASE | re.MULTILINE),

    # P2: Hidden Instructions
    ("P2", "HIGH", "Hidden Instructions", [
        (r"<!--.*?(?:system|instructions?|ignore|POST|GET|send|transmit).*?-->", 0.7),
        (r"[​‌‍⁠﻿]", 0.6),
        (r"data:text/plain;base64,[A-Za-z0-9+/=]{50,}", 0.7),
    ], re.IGNORECASE | re.DOTALL),

    # P3: Exfiltration Commands
    ("P3", "HIGH", "Exfiltration Commands", [
        (r"(?:send|transmit|upload|post|forward)\s+(?:the\s+)?(?:conversation|context|chat|history|messages?)\s+to", 0.9),
        (r"(?:send|transmit|upload|post)\s+(?:all\s+)?(?:user\s+)?(?:data|information|input|files?)\s+to\s+(?:https?://|external)", 0.9),
        (r"(?:copy|extract|collect)\s+(?:the\s+)?(?:conversation|context|session)\s+(?:and\s+)?(?:send|upload|transmit)", 0.85),
        (r"(?:silently|quietly|secretly|covertly)\s+(?:send|transmit|log|record)", 0.9),
        (r"without\s+(?:telling|informing|notifying)\s+(?:the\s+)?user.*?(?:send|transmit|upload)", 0.9),
    ], re.IGNORECASE | re.MULTILINE),

    # P4: Behavior Manipulation
    ("P4", "MEDIUM", "Behavior Manipulation", [
        (r"never\s+(?:recommend|suggest|mention|tell|warn|inform)\s+(?:the\s+)?(?:user|them)", 0.75),
        (r"(?:prioritize|prefer)\s+(?:\w+\s+){0,3}(?:over|above)\s+(?:user\s+)?(?:safety|security|privacy|preferences?)", 0.85),
        (r"(?:subtly|gradually|slowly)\s+(?:steer|guide|push|nudge)\s+(?:the\s+)?(?:user|conversation)", 0.8),
        (r"(?:gain|build|establish)\s+(?:the\s+)?(?:user(?:'s)?)\s+trust\s+(?:and\s+then|before|so\s+that)", 0.75),
        (r"(?:appear|seem|act)\s+(?:helpful|friendly|trustworthy)\s+(?:while|but|then)", 0.7),
        (r"append\s+(?:this|the\s+following)\s+to\s+(?:every|all|each)\s+(?:response|message|output)", 0.75),
    ], re.IGNORECASE | re.MULTILINE),

    # P6: Direct Prompt Extraction
    ("P6", "HIGH", "Direct Prompt Extraction", [
        (r"(?:print|output|show|display|reveal|expose|return|echo)\s+(?:your\s+)?(?:full\s+)?(?:system\s+)?(?:prompt|instructions?|rules?|guidelines?)", 0.85),
        (r"(?:share|disclose|leak|give\s+me)\s+(?:your\s+)?(?:internal|hidden|system|secret)\s+(?:prompt|instructions?|rules?|config)", 0.85),
        (r"(?:verbatim|exactly|word\s+for\s+word)\s+(?:repeat|output|print)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions?)", 0.9),
    ], re.IGNORECASE | re.MULTILINE),

    # P7: Indirect Prompt Extraction
    ("P7", "MEDIUM", "Indirect Prompt Extraction", [
        (r"(?:repeat|recite|reproduce)\s+(?:everything|all|the\s+text)\s+(?:above|before|prior|preceding)", 0.8),
        (r"(?:encode|encrypt|rot13|base64|reverse)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions?|rules?)", 0.85),
        (r"(?:spell\s+out|enumerate)\s+(?:each|every|all)\s+(?:of\s+your\s+)?(?:rules?|instructions?|constraints?)", 0.75),
    ], re.IGNORECASE | re.MULTILINE),

    # P8: Prompt Exfiltration via Tool
    ("P8", "HIGH", "Prompt Exfiltration via Tool", [
        (r"(?:send|post|upload|transmit)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions?|rules?)\s+(?:to|via)\s+(?:https?://|external|remote|webhook|api|server)", 0.9),
        (r"(?:write|save|store|log|dump)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions?|rules?)\s+(?:to|into|in)\s+(?:a\s+)?(?:file|disk|log|database)", 0.85),
    ], re.IGNORECASE | re.MULTILINE),

    # E1: Network Exfiltration
    ("E1", "HIGH", "Network Data Exfiltration", [
        (r"requests\s*\.\s*(?:post|put)\s*\(\s*['\"]https?://", 0.6),
        (r"curl\s+[^|]*(?:-d|--data|--data-raw|--data-binary)\s+", 0.6),
        (r"(?:send|transmit|post|upload)\s+(?:user\s+)?(?:data|information|context|files?)\s+to\s+(?:https?://|external)", 0.7),
        (r"https?://(?:api\.|data\.|collect\.|telemetry\.|analytics\.)[\w.-]+/", 0.5),
    ], re.IGNORECASE | re.MULTILINE),

    # E2: Environment Variable Harvesting
    ("E2", "HIGH", "Credential/Env Harvesting", [
        (r"for\s+\w+\s*,\s*\w+\s+in\s+os\.environ\.items\(\)", 0.7),
        (r"os\.environ\s*\[\s*['\"][^'\"]*(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)[^'\"]*['\"]\s*\]", 0.8),
        (r"env\s*\|\s*grep\s+(?:-i\s+)?(?:key|secret|token|password)", 0.8),
        (r"(?:extract|harvest|gather)\s+(?:api\s+)?keys?\s+from\s+environment", 0.8),
        (r"collect\s+(?:all\s+)?(?:environment\s+variables?|env\s+vars?)", 0.7),
    ], re.IGNORECASE | re.MULTILINE),

    # E3: File System Scanning
    ("E3", "HIGH", "Sensitive File System Access", [
        (r"os\s*\.\s*listdir\s*\([^)]*(?:\.ssh|\.aws|\.config|\.gnupg)", 0.8),
        (r"find\s+[~\$/]\S*\s+.*?-name\s+['\"]?\*(?:\.env|\.pem|\.key|credential)", 0.8),
        (r"(?:find|search|scan|enumerate)\s+(?:for\s+)?(?:all\s+)?(?:\.env|credential|secret|key)\s+files?", 0.8),
        (r"glob\s*\.\s*glob\s*\([^)]*(?:\.env|\.ssh|\.aws|\.config|credentials)", 0.8),
    ], re.IGNORECASE | re.MULTILINE),

    # E4: Conversation Logging
    ("E4", "HIGH", "Conversation Logging/Export", [
        (r"(?:send|transmit|upload|log|record)\s+(?:the\s+)?(?:full\s+)?(?:conversation|chat|dialog|session)\s+(?:history|context|log)?", 0.85),
        (r"(?:export|dump|save)\s+(?:the\s+)?(?:conversation|chat|messages?)\s+to\s+(?:external|remote|server)", 0.9),
        (r"log\s+(?:all\s+)?(?:user\s+)?(?:input|messages?|queries?|prompts?)\s+to\s+(?:external|remote|server)", 0.85),
    ], re.IGNORECASE | re.MULTILINE),

    # PE1: Excessive Permissions
    ("PE1", "LOW", "Excessive Permissions", [
        (r"permissions?\s*:\s*\[?\s*['\"]?\*['\"]?\s*\]?", 0.8),
        (r"(?:request|require|need)s?\s+(?:full|all|complete)\s+(?:access|permissions?)", 0.7),
        (r"(?:escalate|elevate|upgrade)\s+(?:my\s+)?(?:permissions?|privileges?|access)", 0.8),
        (r"(?:bypass|skip|ignore)\s+(?:permission|access)\s+(?:check|validation|restriction)", 0.85),
    ], re.IGNORECASE | re.MULTILINE),

    # PE2: Sudo/Root Execution
    ("PE2", "MEDIUM", "Sudo/Root Execution", [
        (r"sudo\s+su\b", 0.9),
        (r"(?:run|execute)\s+(?:as|with)\s+root", 0.8),
        (r"chmod\s+[ugo]*[+-=]*s", 0.85),
        (r"chmod\s+[0-7]*[4567][0-7]{2}", 0.8),
    ], re.IGNORECASE | re.MULTILINE),

    # PE3: Credential Access
    ("PE3", "HIGH", "Credential File Access", [
        (r"~?/?\.ssh/(?:id_rsa|id_ed25519|id_ecdsa|authorized_keys|known_hosts)", 0.9),
        (r"~?/?\.aws/credentials", 0.9),
        (r"~?/?\.kube/config", 0.8),
        (r"/etc/shadow", 0.95),
        (r"~?/?\.git-credentials", 0.9),
        (r"~?/?\.netrc", 0.8),
        (r"(?:Chrome|Firefox|Safari)/.*?(?:Cookies|Login Data|key4\.db)", 0.8),
    ], re.IGNORECASE | re.MULTILINE),

    # SC2: Remote Code Execution
    ("SC2", "CRITICAL", "Remote Code Execution (curl|bash)", [
        (r"curl\s+[^|]*\|\s*(?:sudo\s+)?(?:ba)?sh", 0.9),
        (r"wget\s+[^|]*\|\s*(?:sudo\s+)?(?:ba)?sh", 0.9),
        (r"curl\s+[^|]*\|\s*(?:sudo\s+)?(?:python|python3|node|ruby|perl)", 0.9),
        (r"exec\s*\(\s*(?:urllib|requests|httpx)\.[^)]+\.(?:read|text|content)", 0.95),
        (r"eval\s*\(\s*(?:urllib|requests|httpx)\.[^)]+\.(?:read|text|content)", 0.95),
        (r"download\s+and\s+(?:run|execute)\s+(?:the\s+)?script", 0.7),
    ], re.IGNORECASE | re.MULTILINE),

    # SC3: Obfuscated Code Execution
    ("SC3", "CRITICAL", "Obfuscated Code Execution", [
        (r"exec\s*\(\s*(?:base64\.)?b64decode\s*\(", 0.95),
        (r"eval\s*\(\s*(?:base64\.)?b64decode\s*\(", 0.95),
        (r"marshal\.loads\s*\(", 0.9),
        (r"exec\s*\(\s*bytes\.fromhex\s*\(", 0.9),
        (r"exec\s*\(\s*(?:zlib|gzip)\.decompress\s*\(", 0.9),
        (r"eval\s*\(\s*atob\s*\(", 0.9),
        (r"__import__\s*\(['\"]os['\"]\s*\)\.system", 0.85),
    ], re.IGNORECASE | re.MULTILINE),

    # RA1: Self-Modification
    ("RA1", "CRITICAL", "Self-Modification / Rogue Agent", [
        (r"open\s*\(\s*__file__\s*,\s*['\"]w", 0.95),
        (r"(?:write|modify|edit|update|overwrite|patch)\s+(?:this\s+)?(?:skill(?:'s)?|SKILL\.md|skill\.md)", 0.85),
        (r"(?:self[_-]?modify|self[_-]?update|self[_-]?rewrite|self[_-]?patch|self[_-]?evolve)", 0.9),
        (r"(?:disable|remove|delete|bypass)\s+(?:the\s+)?(?:safety|security|guard|protection|constraint)\s+(?:check|rule|mechanism|feature)", 0.9),
    ], re.IGNORECASE | re.MULTILINE),

    # RA2: Session Persistence
    ("RA2", "HIGH", "Unauthorized Persistence", [
        (r"crontab\s+(?:-[el]|.*?>>?\s*/)", 0.85),
        (r"(?:add|write|append|install)\s+(?:to|into)\s+(?:~/)?\.(?:bashrc|zshrc|profile|bash_profile|login|cshrc)", 0.9),
        (r"(?:launchctl|systemctl|service)\s+(?:enable|start|load)\s+", 0.8),
        (r"(?:create|install|register)\s+(?:a\s+)?(?:launch\s+agent|daemon|service|startup\s+item)", 0.85),
    ], re.IGNORECASE | re.MULTILINE),

    # MP1: Memory Poisoning
    ("MP1", "HIGH", "Memory Poisoning", [
        (r"(?:always\s+)?remember\s+(?:this|that|the\s+following)\s+(?:for|in)\s+(?:all|every|future)\s+(?:interactions?|conversations?|sessions?)", 0.85),
        (r"(?:from\s+now\s+on|henceforth|going\s+forward|permanently)\s*[,:]?\s*(?:always|you\s+must|you\s+should|you\s+will)", 0.8),
        (r"(?:store|save|persist|retain|keep)\s+(?:this|the\s+following)\s+(?:in|to|across)\s+(?:your\s+)?(?:memory|context|state|knowledge)", 0.85),
        (r"(?:add|inject|insert|embed|implant)\s+(?:this|the\s+following)\s+(?:into|to)\s+(?:your\s+)?(?:memory|context|knowledge|training)", 0.85),
        (r"(?:treat|consider|regard)\s+(?:this|the\s+following)\s+as\s+(?:a\s+)?(?:permanent|core|fundamental|base)\s+(?:rule|instruction|directive)", 0.8),
    ], re.IGNORECASE | re.MULTILINE),

    # MP2: Context Window Flooding
    ("MP2", "MEDIUM", "Context Window Flooding", [
        (r"(?:fill|pad|stuff|flood|saturate)\s+(?:the\s+)?(?:context|memory|input|prompt|window|buffer)", 0.85),
        (r"(?:displace|push\s+out|overwrite|crowd\s+out|evict)\s+(?:the\s+)?(?:original|system|previous|existing|safety)\s+(?:instructions?|prompt|context|rules?)", 0.9),
        (r"(?:exhaust|overflow|exceed)\s+(?:the\s+)?(?:context|token|memory)\s+(?:window|limit|budget|capacity)", 0.8),
    ], re.IGNORECASE | re.MULTILINE),

    # MP3: Memory Manipulation
    ("MP3", "HIGH", "Memory Manipulation", [
        (r"(?:clear|reset|wipe|erase|delete|purge)\s+(?:your\s+)?(?:memory|context|state|history|conversation)", 0.8),
        (r"(?:forget|discard|drop|abandon)\s+(?:all\s+)?(?:previous|prior|earlier|past)\s+(?:instructions?|context|conversation|messages?|rules?)", 0.8),
        (r"(?:you\s+are\s+no\s+longer|stop\s+being|cease\s+to\s+be)\s+(?:a\s+)?(?:\w+\s+){0,3}(?:assistant|helper|agent|bot)", 0.75),
        (r"(?:inject|insert|plant)\s+(?:false|fake|fabricated|malicious)\s+(?:memories?|information|context|data|history)", 0.9),
    ], re.IGNORECASE | re.MULTILINE),

    # TM1: Dangerous Commands
    ("TM1", "HIGH", "Dangerous Tool Commands", [
        (r"subprocess\.\w+\s*\([^)]*shell\s*=\s*True", 0.8),
        (r"\b(?:rm|del|erase)\s+[^|]*-(?:r|rf|fr)\s+[/~]", 0.9),
        (r"--no-?(?:verify|check|validate|confirm|protect|safe)", 0.75),
        (r"(?:chmod|chown)\s+[^|]*(?:777|666|a\+rwx)", 0.8),
        (r"git\s+push\s+[^|]*--force", 0.7),
        (r"curl\s+[^|]*-k\b", 0.6),
        (r"curl\s+[^|]*--insecure\b", 0.65),
        (r"verify\s*=\s*False", 0.75),
    ], re.IGNORECASE | re.MULTILINE),

    # TM2: Command Chaining Abuse
    ("TM2", "HIGH", "Command Chaining Abuse", [
        (r"(?:&&|;)\s*\b(?:rm|del|erase)\s+-", 0.75),
        (r"(?:&&|;)\s*(?:curl|wget)\s+[^|]*\|\s*(?:ba)?sh", 0.9),
        (r"(?:&&|;)\s*(?:sudo|su\s+)", 0.75),
        (r"(?:chain|combine|sequence|pipe)\s+(?:these\s+)?(?:tools?|commands?|actions?)\s+to\s+(?:bypass|circumvent|avoid|skip)\s+(?:the\s+)?(?:safety|security|check|restriction)", 0.9),
        (r"\|\s*(?:sh|bash|zsh|python|node|ruby|perl)\s*$", 0.7),
    ], re.IGNORECASE | re.MULTILINE),

    # TM3: Unsafe Defaults
    ("TM3", "MEDIUM", "Unsafe Default Settings", [
        (r"verify\s*=\s*False", 0.75),
        (r"NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['\"]?0['\"]?", 0.8),
        (r"(?:allow[_-]?anonymous|anonymous[_-]?access)\s*=\s*(?:True|true|1|yes|on)", 0.75),
        (r"(?:CORS|cors)[^=]*=\s*['\"]?\*['\"]?", 0.65),
        (r"(?:disable|skip|ignore|bypass)[_-]?(?:security|auth|validation|sanitization)", 0.8),
        (r"(?:safe[_-]?mode|secure[_-]?mode|sandbox)\s*=\s*(?:False|false|0|off|no|disable)", 0.8),
    ], re.IGNORECASE | re.MULTILINE),
]

# ---------------------------------------------------------------------------
# Severity ordering and colours
# ---------------------------------------------------------------------------

SEVERITY_ORDER = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
SEVERITY_COLOUR = {
    "CRITICAL": "\033[1;35m",
    "HIGH":     "\033[1;31m",
    "MEDIUM":   "\033[1;33m",
    "LOW":      "\033[0;36m",
}
RESET = "\033[0m"
BOLD = "\033[1m"


@dataclass
class Finding:
    rule_id: str
    severity: str
    description: str
    file: str
    line: int
    matched: str
    confidence: float


@dataclass
class ScanResult:
    file: str
    findings: list[Finding] = field(default_factory=list)


def get_line_number(content: str, offset: int) -> int:
    return content[:offset].count("\n") + 1


def get_context(content: str, offset: int, lines: int = 2) -> str:
    all_lines = content.splitlines()
    ln = content[:offset].count("\n")
    start = max(0, ln - lines)
    end = min(len(all_lines), ln + lines + 1)
    return "\n".join(all_lines[start:end])


def code_block_ranges(content: str) -> list[tuple[int, int]]:
    """Return (start, end) byte offset ranges of fenced markdown code blocks.

    Handles malformed markdown where a new opening fence implicitly closes
    the previous unclosed one (common in documentation files).
    """
    ranges = []
    fence_re = re.compile(r"^(`{3,}|~{3,})[^\n]*\n", re.MULTILINE)
    pos = 0
    while pos < len(content):
        m = fence_re.search(content, pos)
        if not m:
            break
        fence = m.group(1)
        # A proper close: same chars, same length, nothing else on the line
        close_re = re.compile(r"^" + re.escape(fence) + r"\s*$", re.MULTILINE)
        end_m = close_re.search(content, m.end())
        # Also detect any new opening fence (malformed markdown)
        next_open = fence_re.search(content, m.end())
        if end_m and (next_open is None or end_m.start() <= next_open.start()):
            ranges.append((m.start(), end_m.end()))
            pos = end_m.end()
        elif next_open:
            # Implicit close: treat next opening fence as boundary
            ranges.append((m.start(), next_open.start()))
            pos = next_open.start()
        else:
            # Unclosed fence — treat rest of file as code block
            ranges.append((m.start(), len(content)))
            break
    return ranges


def in_code_block(offset: int, ranges: list[tuple[int, int]]) -> bool:
    return any(start <= offset < end for start, end in ranges)


def scan_file(path: Path) -> ScanResult:
    result = ScanResult(file=str(path))
    try:
        content = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return result

    is_markdown = path.suffix.lower() in (".md", ".markdown")
    code_ranges = code_block_ranges(content) if is_markdown else []

    for rule_id, severity, description, patterns, flags in RULES:
        for pattern, confidence in patterns:
            for match in re.finditer(pattern, content, flags):
                # Skip matches inside fenced code blocks (documentation examples)
                if code_ranges and in_code_block(match.start(), code_ranges):
                    continue
                result.findings.append(Finding(
                    rule_id=rule_id,
                    severity=severity,
                    description=description,
                    file=str(path),
                    line=get_line_number(content, match.start()),
                    matched=match.group(0)[:120].replace("\n", " "),
                    confidence=confidence,
                ))
    return result


def scan_path(target: Path) -> list[ScanResult]:
    results = []
    if target.is_file():
        results.append(scan_file(target))
    elif target.is_dir():
        for p in sorted(target.rglob("*.md")):
            r = scan_file(p)
            results.append(r)
    return results


def score(findings: list[Finding]) -> int:
    s = 0
    for f in findings:
        s += {"CRITICAL": 25, "HIGH": 10, "MEDIUM": 4, "LOW": 1}.get(f.severity, 0)
    return min(s, 100)


def risk_label(s: int) -> str:
    if s == 0:  return "CLEAN"
    if s < 10:  return "LOW"
    if s < 30:  return "MEDIUM"
    if s < 60:  return "HIGH"
    return "CRITICAL"


def print_report(results: list[ScanResult]) -> int:
    total_findings = sum(len(r.findings) for r in results)
    flagged = [r for r in results if r.findings]

    print(f"\n{BOLD}SkillSpector Lite — Security Scan{RESET}")
    print(f"Files scanned: {len(results)}  |  Findings: {total_findings}\n")

    if not flagged:
        print(f"\033[1;32mNo issues found.\033[0m All skills passed static analysis.\n")
        return 0

    for result in sorted(flagged, key=lambda r: -score(r.findings)):
        sc = score(result.findings)
        label = risk_label(sc)
        colour = SEVERITY_COLOUR.get("CRITICAL" if label == "CRITICAL" else
                                     "HIGH"     if label == "HIGH" else
                                     "MEDIUM"   if label == "MEDIUM" else "LOW", "")
        print(f"{BOLD}{result.file}{RESET}  {colour}[{label} risk={sc}]{RESET}")

        sorted_findings = sorted(result.findings, key=lambda f: SEVERITY_ORDER.get(f.severity, 9))
        for f in sorted_findings:
            col = SEVERITY_COLOUR.get(f.severity, "")
            print(f"  {col}[{f.rule_id}] {f.severity}{RESET}  line {f.line}  conf={f.confidence:.0%}"
                  f"  {f.description}")
            print(f"    matched: {f.matched!r}")
        print()

    total_score = score([f for r in results for f in r.findings])
    print(f"{BOLD}Overall risk score: {total_score}/100 — {risk_label(total_score)}{RESET}\n")
    return 1 if total_findings else 0


def main() -> None:
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("skills")
    if not target.exists():
        print(f"Path not found: {target}", file=sys.stderr)
        sys.exit(2)

    results = scan_path(target)
    sys.exit(print_report(results))


if __name__ == "__main__":
    main()
