using DineroBook.Processor;
using Xunit;

namespace Processor.Tests;

/// <summary>
/// <see cref="NoPromptLaunch"/>: the scheduled task and the desktop shortcut
/// that open DineroBook Manager with administrator rights, without the
/// Windows prompt (the owner's LdPosService way). Creating the task itself
/// needs administrator rights, so these check what is asked of Windows and
/// that the shortcut file says the right thing.
/// </summary>
public class NoPromptLaunchTests
{
    private const string Installed = @"C:\Program Files\DineroBook\Processor\DineroBookManager.exe";

    [Fact]
    public void The_task_starts_the_Program_Files_copy_with_highest_privileges_and_never_by_itself()
    {
        var args = NoPromptLaunch.CreateArguments(Installed);

        Assert.Equal("/Create", args[0]);
        Assert.Equal(NoPromptLaunch.TaskName, args[args.ToList().IndexOf("/TN") + 1]);
        // The program, quoted, plus the flag that stops it sending itself round again.
        Assert.Equal("\"" + Installed + "\" --from-task", args[args.ToList().IndexOf("/TR") + 1]);
        Assert.Equal("HIGHEST", args[args.ToList().IndexOf("/RL") + 1]);
        Assert.Equal("ONCE", args[args.ToList().IndexOf("/SC") + 1]);
        Assert.Contains("/IT", args);
        Assert.Contains("/F", args);
    }

    [Fact]
    public void Running_and_removing_name_the_same_task()
    {
        Assert.Equal(["/Run", "/TN", NoPromptLaunch.TaskName], NoPromptLaunch.RunArguments);
        Assert.Equal(["/Delete", "/F", "/TN", NoPromptLaunch.TaskName], NoPromptLaunch.DeleteArguments);
        Assert.Equal("/Run /TN \"DineroBook\\Manager\"", NoPromptLaunch.ShortcutArguments);
    }

    [Fact]
    public void The_shortcut_runs_the_task_with_the_Managers_icon()
    {
        using var dir = new TempDir();
        var path = Path.Combine(dir.Path, NoPromptLaunch.ShortcutName);
        var icon = Path.Combine(Environment.SystemDirectory, "notepad.exe"); // any real file

        NoPromptLaunch.WriteShortcut(path, NoPromptLaunch.Schtasks, NoPromptLaunch.ShortcutArguments, icon,
            dir.Path, "test");

        var (target, arguments, iconFile) = NoPromptLaunch.ReadShortcut(path);
        Assert.Equal(NoPromptLaunch.Schtasks, target, ignoreCase: true);
        Assert.Equal(NoPromptLaunch.ShortcutArguments, arguments);
        Assert.Equal(icon, iconFile, ignoreCase: true);
    }
}
