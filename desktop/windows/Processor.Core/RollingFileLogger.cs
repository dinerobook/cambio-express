using System.Globalization;
using System.Text;
using Microsoft.Extensions.Logging;

namespace DineroBook.Processor;

/// <summary>
/// One log file per day (<c>processor-yyyyMMdd.log</c>). Only today's is
/// kept (owner, 2026-11-21): the day's first line deletes every older file.
/// Errors also go to the Windows Event Log, which keeps its own history.
/// A day's file stops taking routine lines at
/// <see cref="MaxBytesPerDay"/> (warnings and errors still go in), so a
/// backlog of thousands of files cannot fill the disk. Readers (the
/// Manager's log page) can open the file while it is being written.
/// </summary>
public sealed class RollingFileLoggerProvider : ILoggerProvider
{
    public const long MaxBytesPerDay = 50L * 1024 * 1024;

    private readonly string _folder;
    private readonly string _prefix;
    private readonly LogLevel _minimum;
    private readonly Func<DateTimeOffset> _now;
    private readonly object _gate = new();
    private DateOnly _day;
    private FileStream? _stream;
    private bool _broken;

    public RollingFileLoggerProvider(string folder, string prefix = "processor",
        LogLevel minimum = LogLevel.Information, Func<DateTimeOffset>? now = null)
    {
        _folder = folder;
        _prefix = prefix;
        _minimum = minimum;
        _now = now ?? (() => DateTimeOffset.Now);
    }

    public ILogger CreateLogger(string categoryName) => new FileLogger(this);

    public static string FileNameFor(string prefix, DateOnly day) =>
        $"{prefix}-{day.ToString("yyyyMMdd", CultureInfo.InvariantCulture)}.log";

    internal void Write(LogLevel level, string message, Exception? exception)
    {
        if (level < _minimum || level == LogLevel.None) return;
        var now = _now();
        var line = new StringBuilder()
            .Append(now.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture))
            .Append(' ').Append(Label(level)).Append(' ')
            .Append(message.Replace("\r", " ").Replace("\n", " "));
        if (exception is not null) line.Append(" | ").Append(exception.GetType().Name).Append(": ").Append(exception.Message.Replace("\r", " ").Replace("\n", " "));
        line.Append("\r\n");
        var bytes = Encoding.UTF8.GetBytes(line.ToString());

        lock (_gate)
        {
            try
            {
                var stream = StreamFor(DateOnly.FromDateTime(now.LocalDateTime));
                if (stream is null) return;
                if (stream.Length > MaxBytesPerDay && level < LogLevel.Warning) return;
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush();
            }
            catch (IOException)
            {
                // A log that cannot be written must never stop the uploads.
                CloseStream();
            }
            catch (UnauthorizedAccessException)
            {
                _broken = true;
                CloseStream();
            }
        }
    }

    private FileStream? StreamFor(DateOnly day)
    {
        if (_broken) return null;
        if (_stream is not null && _day == day) return _stream;
        CloseStream();
        Directory.CreateDirectory(_folder);
        _day = day;
        _stream = new FileStream(Path.Combine(_folder, FileNameFor(_prefix, day)), FileMode.Append,
            FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
        DeleteOld(day);
        return _stream;
    }

    private void DeleteOld(DateOnly today)
    {
        try
        {
            foreach (var file in Directory.EnumerateFiles(_folder, _prefix + "-*.log"))
            {
                var stamp = Path.GetFileNameWithoutExtension(file)[(_prefix.Length + 1)..];
                if (DateOnly.TryParseExact(stamp, "yyyyMMdd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d)
                    && d < today)
                {
                    File.Delete(file);
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }

    private void CloseStream()
    {
        try { _stream?.Dispose(); } catch (IOException) { }
        _stream = null;
    }

    private static string Label(LogLevel level) => level switch
    {
        LogLevel.Trace => "TRACE",
        LogLevel.Debug => "DEBUG",
        LogLevel.Information => "INFO ",
        LogLevel.Warning => "WARN ",
        LogLevel.Error => "ERROR",
        _ => "FATAL",
    };

    public void Dispose()
    {
        lock (_gate) CloseStream();
    }

    private sealed class FileLogger(RollingFileLoggerProvider owner) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => logLevel >= owner._minimum && logLevel != LogLevel.None;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel)) return;
            owner.Write(logLevel, formatter(state, exception), exception);
        }
    }
}
