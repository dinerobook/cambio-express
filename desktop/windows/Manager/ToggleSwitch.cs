using System.Drawing.Drawing2D;

namespace DineroBook.Manager;

/// <summary>
/// An on/off switch (owner, 2026-11-20: switches, not checkboxes). It is a
/// <see cref="CheckBox"/> underneath, so <c>Checked</c>, the space bar, focus
/// and screen readers work exactly as before; only the drawing changes.
/// The track uses the Windows accent colour when on, and scales with the
/// font (and so with the screen's DPI).
/// </summary>
internal sealed class ToggleSwitch : CheckBox
{
    private const int Gap = 8;

    public ToggleSwitch()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint
                 | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        Cursor = Cursors.Hand;
    }

    private Size Track
    {
        get
        {
            var h = Math.Max(16, Font.Height + 2);
            return new Size(h * 2 - 2, h);
        }
    }

    public override Size GetPreferredSize(Size proposedSize)
    {
        var track = Track;
        var text = TextRenderer.MeasureText(Text, Font);
        return new Size(track.Width + Gap + text.Width + 2, Math.Max(track.Height, text.Height) + 2);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.Clear(Parent?.BackColor ?? SystemColors.Control);
        g.SmoothingMode = SmoothingMode.AntiAlias;

        var track = Track;
        var top = (Height - track.Height) / 2;
        var bounds = new Rectangle(1, top, track.Width - 1, track.Height - 1);
        var on = Checked;
        var fill = !Enabled
            ? SystemColors.ControlLight
            : on ? SystemColors.Highlight : SystemColors.Window;
        var edge = !Enabled
            ? SystemColors.ControlDark
            : on ? SystemColors.Highlight : SystemColors.ControlDarkDark;

        using (var path = Pill(bounds))
        using (var brush = new SolidBrush(fill))
        using (var pen = new Pen(edge, 1.5f))
        {
            g.FillPath(brush, path);
            g.DrawPath(pen, path);
        }

        var knob = bounds.Height - 6;
        var knobX = on ? bounds.Right - knob - 3 : bounds.Left + 3;
        var knobColor = !Enabled
            ? SystemColors.ControlDark
            : on ? SystemColors.HighlightText : SystemColors.ControlDarkDark;
        using (var brush = new SolidBrush(knobColor))
        {
            g.FillEllipse(brush, knobX, bounds.Top + 3, knob, knob);
        }

        var textBounds = new Rectangle(track.Width + Gap, 0, Width - track.Width - Gap, Height);
        TextRenderer.DrawText(g, Text, Font, textBounds,
            Enabled ? ForeColor : SystemColors.GrayText,
            TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.EndEllipsis);

        if (Focused && ShowFocusCues)
        {
            ControlPaint.DrawFocusRectangle(g, new Rectangle(textBounds.Left - 2, 1, textBounds.Width, Height - 2));
        }
    }

    protected override void OnCheckedChanged(EventArgs e)
    {
        base.OnCheckedChanged(e);
        Invalidate();
    }

    protected override void OnEnabledChanged(EventArgs e)
    {
        base.OnEnabledChanged(e);
        Invalidate();
    }

    private static GraphicsPath Pill(Rectangle r)
    {
        var d = r.Height;
        var path = new GraphicsPath();
        path.AddArc(r.Left, r.Top, d, d, 90, 180);
        path.AddArc(r.Right - d, r.Top, d, d, 270, 180);
        path.CloseFigure();
        return path;
    }
}
