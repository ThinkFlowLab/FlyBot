const SCHEMA = 'flybot-workspace.spreadsheet.v1';
const ROWS = 200;
const COLS = 26;
const SHEETS = 8;
const CELL_SIZE = 500;
const columnName = n => String.fromCharCode(65+n);

function clipboardRows(text) {
  return text.replace(/\r\n?/g,'\n').replace(/\n$/,'').split('\n').map(line=>line.split('\t'));
}

export function mountSpreadsheet(document,{onDraft,onTitle}) {
  const root = document.getElementById('spreadsheet-editor');
  const grid = document.getElementById('sheet-grid');
  if (!root || typeof grid?.replaceChildren !== 'function') return {load() {},value() { return null; }};
  const get = name => document.getElementById('sheet-' + name);
  const picker = get('switch');
  const name = get('name');
  const status = get('status');
  const add = get('add');
  const remove = get('remove');
  const addRow = get('add-row');
  const addColumn = get('add-column');
  const draft = get('draft');
  const prompt = get('prompt');
  const generate = get('draft-submit');
  let sheets = [];
  let index = 0;
  let bookId;
  let edits = 0;
  let request;
  let editable = true;

  const node = (tag,text) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const current = () => sheets[index];
  const fresh = (title,rows=[]) => ({name:title,rows:structuredClone(rows),
    height:Math.max(8,rows.length),width:Math.max(6,...rows.map(line=>line.length))});

  function renderTabs() {
    picker.replaceChildren(...sheets.map((sheet,i) => {
      const option = node('option',sheet.name.trim() || '工作表 '+(i+1));
      option.value = String(i);
      return option;
    }));
    picker.value = String(index);
    name.value = current().name;
    add.disabled = sheets.length >= SHEETS;
    remove.disabled = sheets.length === 1;
  }

  function renderGrid() {
    const sheet = current();
    const header = node('tr');
    header.append(node('th'));
    for (let col=0;col<sheet.width;col++) {
      const cell = node('th',columnName(col));
      cell.scope = 'col';
      header.append(cell);
    }
    const head = node('thead');
    head.append(header);
    const body = node('tbody');
    for (let row=0;row<sheet.height;row++) {
      const line = node('tr');
      const label = node('th',String(row+1));
      label.scope = 'row';
      line.append(label);
      for (let col=0;col<sheet.width;col++) {
        const cell = node('td');
        const input = node('input');
        input.type = 'text';
        input.maxLength = CELL_SIZE;
        input.autocomplete = 'off';
        input.dataset.row = String(row);
        input.dataset.col = String(col);
        input.setAttribute('aria-label',columnName(col)+(row+1));
        input.value = sheet.rows[row]?.[col] ?? '';
        cell.append(input);
        line.append(cell);
      }
      body.append(line);
    }
    grid.replaceChildren(head,body);
    addRow.disabled = sheet.height >= ROWS;
    addColumn.disabled = sheet.width >= COLS;
  }

  function setCell(row,col,value) {
    const sheet = current();
    while (sheet.rows.length <= row) sheet.rows.push([]);
    const cells = sheet.rows[row];
    while (cells.length <= col) cells.push('');
    cells[col] = value;
    edits++;
  }

  function touched(event) {
    const cell = event.target;
    return cell.matches?.('input[data-row][data-col]') ? cell : null;
  }

  function focusCell(row,col) {
    grid.querySelector(`input[data-row="${row}"][data-col="${col}"]`)?.focus();
  }

  picker.addEventListener('change',() => {
    index = Number(picker.value);
    renderTabs();
    renderGrid();
  });
  name.addEventListener('input',() => {
    current().name = name.value;
    if (picker.options[index]) picker.options[index].textContent = name.value.trim() || '工作表 '+(index+1);
    edits++;
  });
  add.addEventListener('click',() => {
    if (sheets.length >= SHEETS) return;
    const names = new Set(sheets.map(sheet=>sheet.name.toLowerCase()));
    let sequence = 1;
    while (names.has('sheet'+sequence)) sequence++;
    sheets.push(fresh('Sheet'+sequence));
    index = sheets.length-1;
    edits++;
    renderTabs();
    renderGrid();
    name.focus();
    name.select();
  });
  remove.addEventListener('click',() => {
    if (sheets.length < 2 || !document.defaultView?.confirm('删除工作表「'+current().name+'」？保存后仍可通过历史版本恢复。')) return;
    sheets.splice(index,1);
    index = Math.min(index,sheets.length-1);
    edits++;
    renderTabs();
    renderGrid();
    picker.focus();
  });
  addRow.addEventListener('click',() => {
    if (current().height >= ROWS) return;
    current().height++;
    edits++;
    renderGrid();
    focusCell(current().height-1,0);
  });
  addColumn.addEventListener('click',() => {
    if (current().width >= COLS) return;
    current().width++;
    edits++;
    renderGrid();
    focusCell(0,current().width-1);
  });
  grid.addEventListener('input',event => {
    const cell = touched(event);
    if (cell) setCell(Number(cell.dataset.row),Number(cell.dataset.col),cell.value);
  });
  grid.addEventListener('keydown',event => {
    const cell = touched(event);
    if (!cell || event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    const row = Number(cell.dataset.row) + (event.shiftKey ? -1 : 1);
    focusCell(row,Number(cell.dataset.col));
  });
  grid.addEventListener('paste',event => {
    const cell = touched(event);
    const text = event.clipboardData?.getData('text/plain') || '';
    if (!cell || !/[\r\n\t]/.test(text)) return;
    event.preventDefault();
    status.textContent = '';
    if (text.length > 280000) {
      status.textContent = '粘贴内容超出工作表或单元格容量。';
      return;
    }
    const rows = clipboardRows(text);
    const firstRow = Number(cell.dataset.row);
    const firstCol = Number(cell.dataset.col);
    const width = rows.reduce((max,line)=>Math.max(max,line.length),0);
    if (firstRow+rows.length>ROWS || firstCol+width>COLS || rows.some(line=>line.some(value=>value.length>CELL_SIZE))) {
      status.textContent = '粘贴内容超出工作表或单元格容量。';
      return;
    }
    current().height = Math.max(current().height,firstRow+rows.length);
    current().width = Math.max(current().width,firstCol+width);
    rows.forEach((line,row) => line.forEach((value,col) => setCell(firstRow+row,firstCol+col,value)));
    renderGrid();
    focusCell(firstRow,firstCol);
  });

  function load(workbook,id,suggest=true) {
    request = undefined;
    editable = suggest;
    const same = bookId && bookId === id;
    bookId = id;
    sheets = workbook?.sheets?.length ? workbook.sheets.map(sheet=>fresh(sheet.name,sheet.rows)) : [fresh('Sheet1')];
    index = same ? Math.min(index,sheets.length-1) : 0;
    edits++;
    draft.hidden = !editable;
    draft.open = false;
    prompt.value = '';
    generate.disabled = false;
    status.textContent = '';
    renderTabs();
    renderGrid();
  }

  generate.addEventListener('click',async () => {
    const input = prompt.value.trim();
    if (!input || !editable || request) return;
    if (sheets.some(sheet=>sheet.rows.some(row=>row.some(cell=>cell.trim())))) {
      status.textContent = '请保存当前内容，再新建一份空表格起草。';
      return;
    }
    const pending = request = {edits};
    generate.disabled = true;
    status.textContent = '智能体正在起草…';
    try {
      const result = await onDraft(input);
      const form = root.closest('form');
      if (request !== pending || form?.hidden || form?.inert || root.hidden) return;
      if (edits !== pending.edits) {
        status.textContent = '草稿已返回。你修改了当前表格，内容保持原样。';
        return;
      }
      load(result.spreadsheet,undefined,true);
      onTitle(result.title);
      status.textContent = '草稿已填入。核对后保存。';
    } catch (error) {
      if (request === pending) status.textContent = error?.message || '无法生成表格草稿，请重试。';
    } finally {
      if (request === pending) {
        request = undefined;
        generate.disabled = false;
      }
    }
  });

  return {load,value() {
    return {schema:SCHEMA,sheets:sheets.map(sheet => {
      const rows = Array.from({length:sheet.height},(_,i)=>[...(sheet.rows[i] || [])]);
      while (rows.at(-1).length < sheet.width) rows.at(-1).push('');
      return {name:sheet.name.trim(),rows};
    })};
  }};
}
