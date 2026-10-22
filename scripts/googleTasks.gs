/*
 * Google Tasks for the Weather Calendar display (see
 * server/GoogleTasksManager.js): a Google Apps Script web app that returns
 * your tasks as JSON, so the display can read them without signing in to
 * Google itself. It runs as you, inside your Google account.
 *
 * To set it up:
 * 1. Go to https://script.google.com and click New project.
 * 2. Replace everything in Code.gs with this file (config/googleTasks.gs
 *    is a copy with the display's key already filled in).
 * 3. On the left, click + next to Services, choose Google Tasks API, and
 *    click Add.
 * 4. Click Deploy > New deployment. For the type (the gear), choose Web app.
 *    Set Execute as: Me, and Who has access: Anyone. Click Deploy, and allow
 *    access when asked (Google will say it's unverified, as it's your own
 *    script: click Advanced, then Go to the project).
 * 5. Copy the Web app URL into config/googleTasks.json as "url".
 *
 * Anyone with the URL could call it, so it only answers with the key below,
 * which the display sends. Keep both private.
 */
const KEY = 'PASTE_THE_KEY_FROM_config/googleTasks.json';
// Completed tasks are only sent if completed in the last this many days
const COMPLETED_DAYS = 3;

function doGet(e) {
  if (!e || !e.parameter || e.parameter.key !== KEY) return json({ error: 'Not allowed' });
  // (completed ones from before this are left out here: Google's own
  // completedMin filter would leave out every task not yet completed)
  const completedMin = new Date(Date.now() - COMPLETED_DAYS * 24 * 3600 * 1000).toISOString();
  const tasks = [];
  let listPage;
  do {
    const lists = Tasks.Tasklists.list({ maxResults: 100, pageToken: listPage });
    for (const list of lists.items || []) {
      let page;
      do {
        const result = Tasks.Tasks.list(list.id, {
          maxResults: 100,
          showCompleted: true,
          showHidden: true,
          pageToken: page,
        });
        for (const task of result.items || []) {
          if (!task.title) continue;
          if (task.completed && task.completed < completedMin) continue;
          tasks.push({
            id: task.id,
            listId: list.id,
            list: list.title,
            title: task.title,
            notes: task.notes || '',
            due: task.due || null,
            status: task.status,
            completed: task.completed || null,
          });
        }
        page = result.nextPageToken;
      } while (page);
    }
    listPage = lists.nextPageToken;
  } while (listPage);
  return json({ tasks: tasks, fetchedAt: new Date().toISOString() });
}

// Marks a task completed: a POST of { key, listId, taskId } as JSON, from
// the display when a task is tapped there
function doPost(e) {
  let body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (error) {
    return json({ error: 'Not JSON' });
  }
  if (body.key !== KEY) return json({ error: 'Not allowed' });
  if (!body.listId || !body.taskId) return json({ error: 'Give listId and taskId' });
  const task = Tasks.Tasks.patch({ status: 'completed' }, body.listId, body.taskId);
  return json({ id: task.id, status: task.status, completed: task.completed || null });
}

// Run this once from the editor (choose it in the toolbar, then Run) to
// grant the script permission to change tasks, not just read them: a web
// app can't ask for new permissions itself
function authorize() {
  const lists = Tasks.Tasklists.list({ maxResults: 1 }).items || [];
  if (lists.length) Tasks.Tasks.list(lists[0].id, { maxResults: 1 });
  // (names Tasks.Tasks.patch, so the permission to change tasks is asked for)
  return typeof Tasks.Tasks.patch;
}

function json(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
