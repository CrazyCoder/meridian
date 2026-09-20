import { describe, expect, it } from 'bun:test'
import { agFrameTimes } from '../proxy/backends/antigravityMedia'

describe('Antigravity video source timestamps', () => {
  it('uses selected frame timestamps including variable-rate gaps, not inferred ten-second multiples', () => {
    const log = 'Duration: 00:00:30\n[Parsed_showinfo_1] n:   0 pts: 0 pts_time:0 duration:1\n[Parsed_showinfo_1] n: 1 pts: 10400 pts_time:10.4 duration:1\n[Parsed_showinfo_1] n: 2 pts: 22000 pts_time:2.2e1 duration:1'
    expect(agFrameTimes(log, 3)).toEqual([0, 10.4, 22])
    expect(agFrameTimes(log, 2)).toEqual([0, 10.4])
  })
  it('rejects missing or unusable timestamps rather than manufacturing provenance', () => {
    expect(() => agFrameTimes('pts_time:10', 1)).toThrow('source frame timestamps')
    expect(() => agFrameTimes('n: 0 pts: -1 pts_time:-1', 1)).toThrow('source frame timestamps')
    expect(() => agFrameTimes('n: 0 pts: 0 pts_time:1e999', 1)).toThrow('source frame timestamps')
  })
})
