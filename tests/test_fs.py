from backend.fs import apply


def write(path: str, code: str, overwrite: bool = False):
    return {"action": "write", "path": path, "code": code, "label": "新建", "overwrite": overwrite}


def test_write_new_file():
    state, problem = apply(write("a.js", "let a = 1;\n"), {})
    assert problem is None
    assert state == {"a.js": "let a = 1;\n"}


def test_write_existing_file_needs_overwrite_flag():
    files = {"a.js": "old\n"}
    state, problem = apply(write("a.js", "new\n"), files, observed={"a.js"})
    assert state == files
    assert problem and "edit_file" in problem


def test_write_existing_file_needs_look_first():
    files = {"a.js": "old\n"}
    state, problem = apply(write("a.js", "new\n", overwrite=True), files, observed=set())
    assert state == files
    assert problem and "还没读过" in problem


def test_rewrite_works_after_delete():
    files = {"a.js": "old\n"}
    state, problem = apply({"action": "delete", "path": "a.js"}, files, observed={"a.js"})
    assert problem is None
    state, problem = apply(write("a.js", "new\n"), state, observed={"a.js"})
    assert problem is None
    assert state["a.js"] == "new\n"


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


def test_placeholder_is_not_accepted_as_code():
    note = "（已写入 app.js 的 6120 字符，内容见项目文件，要改先 look）"
    state, problem = apply(write("app.js", note), {})
    assert state == {}
    assert problem and "占位" in problem


def test_inline_html_is_allowed():
    # 单文件 / 内联是用户的选择，不在这里拦
    code = (
        "<!doctype html>\n<style>body { margin: 0; }</style>\n"
        "<script>let a = 1;</script>\n"
    )
    state, problem = apply(write("index.html", code), {})
    assert problem is None
    assert state == {"index.html": code}


def test_html_with_external_refs_is_fine():
    code = (
        '<link rel="stylesheet" href="style.css">\n'
        '<script src="app.js"></script>\n'
        '<script type="module"></script>\n'
    )
    state, problem = apply(write("index.html", code), {})
    assert problem is None
    assert state == {"index.html": code}


def test_delete_missing_file_is_reported():
    # 静默成功会让模型以为删掉了，接着反复删同一个名字
    state, problem = apply({"action": "delete", "path": "gone.js"}, {"a.js": "x"})
    assert problem and "不存在" in problem
    assert state == {"a.js": "x"}


def test_delete_needs_look_first():
    files = {"a.js": "x"}
    state, problem = apply({"action": "delete", "path": "a.js"}, files, observed=set())
    assert state == files
    assert problem and "先 look" in problem


def test_delete():
    state, problem = apply({"action": "delete", "path": "a.js"}, {"a.js": "x", "b.js": "y"})
    assert problem is None
    assert state == {"b.js": "y"}