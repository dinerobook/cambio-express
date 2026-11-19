"""The site agent script (agent/dinerobook_agent.py) picks up the
journal AND every movement report family by default (G-7), still
honours an older install's single ``pattern = PJR*.xml``, and never
ends up watching for nothing."""
import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
AGENT = ROOT / "agent" / "dinerobook_agent.py"


def _agent():
    spec = importlib.util.spec_from_file_location("dinerobook_agent", AGENT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _config(tmp_path, pattern_line):
    ini = tmp_path / "agent.ini"
    ini.write_text(
        "[agent]\napi_url = https://dinerobook.com\nagent_key = pak_x\n"
        f"watch_dir = {tmp_path}\n{pattern_line}",
    )
    return _agent().load_config(str(ini))


@pytest.mark.parametrize("name", [
    "PJR990251205120139277539.xml", "FGM990251205120226277559.xml",
    "ISM990251205120227277560.xml", "MCM990251205120229277561.xml",
    "MSM990251205120230277562.xml", "TLM990251205120232277563.xml",
    "TPM990251205120233277564.xml",
])
def test_default_pattern_sends_every_family(tmp_path, name):
    cfg = _config(tmp_path, "")
    assert _agent().matches(name, cfg["patterns"])


def test_default_skips_other_files(tmp_path):
    agent = _agent()
    cfg = _config(tmp_path, "")
    for name in ("notes.txt", "PJR1.tmp", "XYZ1.xml"):
        assert not agent.matches(name, cfg["patterns"])


def test_the_example_config_is_the_default(tmp_path):
    example = (ROOT / "agent" / "agent.ini.example").read_text()
    [line] = [ln for ln in example.splitlines() if ln.startswith("pattern")]
    assert _config(tmp_path, line)["patterns"] == _config(tmp_path, "")["patterns"]


def test_an_older_install_keeps_its_single_pattern(tmp_path):
    agent = _agent()
    cfg = _config(tmp_path, "pattern = PJR*.xml\n")
    assert cfg["patterns"] == ["PJR*.xml"]
    assert agent.matches("PJR1.xml", cfg["patterns"])
    assert not agent.matches("FGM1.xml", cfg["patterns"])


def test_patterns_split_on_commas_and_spaces(tmp_path):
    cfg = _config(tmp_path, "pattern = PJR*.xml, MSM*.xml  TLM*.xml\n")
    assert cfg["patterns"] == ["PJR*.xml", "MSM*.xml", "TLM*.xml"]


def test_an_empty_pattern_falls_back_to_the_default(tmp_path):
    assert _config(tmp_path, "pattern =\n")["patterns"] == (
        _agent().DEFAULT_PATTERN.split()
    )
