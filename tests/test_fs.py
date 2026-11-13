from backend.fs import apply


def write(path: str, code: str, overwrite: bool = False):
    return {
        "action": "write",
        "path": path,
        "code": code,
        "overwrite": overwrite,
        "label": "新建",
    }


def test_write_new_file():
    state, problem = apply(write("a.js", "let a = 1;\n"), {})
    assert problem is None
    assert state == {"a.js": "let a = 1;\n"}


def test_overwrite_existing_needs_explicit_flag():
    files = {"a.js": "old\n"}
    state, problem = apply(write("a.js", "new\n"), files, observed={"a.js"})
    assert state == files
    assert problem and "overwrite=true" in problem


def test_overwrite_with_flag_wins():
    files = {"a.js": "old\n"}
    state, problem = apply(write("a.js", "new\n", overwrite=True), files, observed={"a.js"})
    assert problem is None
    assert state["a.js"] == "new\n"


def test_write_existing_without_look_is_blocked():
    files = {"a.js": "old\n"}
    state, problem = apply(write("a.js", "new\n", overwrite=True), files, observed=set())
    assert state == files
    assert problem and "还没读过" in problem


def test_edit_requires_file_and_exact_find():
    files = {"a.js": "const a = 1;\n"}
    state, problem = apply(
        {"action": "edit", "path": "missing.js", "find": "x", "replace": "y"}, files
    )
    assert state == files
    assert problem and "不存在" in problem

    state, problem = apply(
        {"action": "edit", "path": "a.js", "find": "const b", "replace": "const c"}, files
    )
    assert state == files
    assert problem and "找不到" in problem


def test_edit_needs_look_first():
    files = {"a.js": "const a = 1;\n"}
    state, problem = apply(
        {"action": "edit", "path": "a.js", "find": "a = 1", "replace": "a = 2"},
        files,
        observed=set(),
    )
    assert state == files
    assert problem and "还没读过" in problem


def test_edit_replaces_exactly_one_segment():
    files = {"a.js": "const a = 1;\nconsole.log(a);\n"}
    state, problem = apply(
        {"action": "edit", "path": "a.js", "find": "a = 1", "replace": "a = 42"},
        files,
        observed={"a.js"},
    )
    assert problem is None
    assert state["a.js"] == "const a = 42;\nconsole.log(a);\n"


def test_delete():
    state, problem = apply({"action": "delete", "path": "a.js"}, {"a.js": "x", "b.js": "y"})
    assert problem is None
    assert state == {"b.js": "y"}